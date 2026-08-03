/**
 * Live `DataSource<GearBench>`: computes the gear bench in the browser with its own
 * aggregation math (it does NOT reference the ingest analysis), mirroring the ingest bench
 * shape. Fetches each top parse's combatant-info gear and rolls it up into talent / trinket /
 * enchant distributions.
 */
import { Injectable, inject } from '@angular/core';
import { WclApiService } from '../../../core/services/wcl-api';
import { CharacterGear, ParseRanking } from '../../../core/models/wcl.models';
import { EncounterGearStats } from '../../../core/models/encounter.models';
import { logWarn } from '../../../core/log';
import { Result, LoadError, ok, missing } from '../../../core/result';
import { toLoadError } from '../../../core/http-load-error';
import { TRINKET_SLOTS, decodeHtmlEntities, extractGear, selectCombatantInfo } from './gear-extract';
import { talentKeyFromTree } from '../../../shared/gear/talent-key';
import { buildTalentDiff } from '../../../shared/gear/gear-comparison';
import { TalentDataService } from '../../../core/services/talent-data';
import { SpecTalents } from '../../../core/models/talent.models';
import { toParseRankings, unwrapRankings } from '../../../shared/analysis/wcl-projections';
import { getOrInsert } from '../../../shared/analysis/analysis-math';
import { DataSource } from '../../../core/data-source/data-source';
import { GearBench } from './gear-data-source';

/** How many top parses to sample (matches the ingest bench). */
const TOP_PARSE_COUNT = 10;
// Over-fetch so a private/unfetchable top parse can be backfilled by the
// next-best one; the break in the loop caps actual fetches at TOP_PARSE_COUNT.
const CANDIDATE_POOL_COUNT = TOP_PARSE_COUNT * 2;
/** Keep at most this many talent builds, and trinkets / enchants per slot. */
const MAX_TALENT_BUILDS = 3;
const MAX_TRINKETS_PER_SLOT = 5;
const MAX_ENCHANTS_PER_SLOT = 3;

function pct(count: number, total: number): number {
  return total ? Math.round((count / total) * 100) : 0;
}

/**
 * One top parse reduced to its gear fingerprint. The parse identity rides along so each
 * bench talent build can link back to an example parse running it.
 */
export interface ParseGear {
  talent_key: string;
  trinkets: { slot: number; id: number; name: string; icon: string }[];
  enchants: { slot: number; id: number; name: string }[];
  report_code: string;
  fight_id: number;
  player_name: string;
  /** The player's actor id within their report - the WCL deep-link `source`. */
  source_id: number;
}

/** Reduce a fetched `CharacterGear` to the aggregation fields, tagged with the parse identity. */
export function toParseGear(gear: CharacterGear | null, ranking: ParseRanking, sourceId: number): ParseGear | null {
  if (!gear?.found) return null;
  return {
    talent_key: gear.talent_key ?? '',
    trinkets: (gear.trinkets ?? []).map(trinket => ({ slot: trinket.slot, id: trinket.id, name: trinket.name, icon: trinket.icon ?? '' })),
    enchants: (gear.enchants ?? []).map(enchant => ({ slot: enchant.slot, id: enchant.id, name: enchant.name })),
    report_code: ranking.report_code,
    fight_id: ranking.fight_id,
    player_name: ranking.player,
    source_id: sourceId,
  };
}

/**
 * Roll per-parse talent fingerprints into the top `MAX_TALENT_BUILDS` builds by
 * frequency, each carrying the first-seen example parse identity.
 */
export function aggregateTalents(parses: ParseGear[]): EncounterGearStats['talent_builds'] {
  const total = parses.length;
  // Carry the first-seen example alongside the count, avoiding a later non-null re-lookup.
  interface TalentAgg { count: number; report_code: string; fight_id: number; player_name: string; source_id: number }
  const talentBuilds = new Map<string, TalentAgg>();

  for (const parse of parses) {
    if (!parse.talent_key) continue;
    const existing = talentBuilds.get(parse.talent_key);
    if (existing) {
      existing.count += 1;
    } else {
      talentBuilds.set(parse.talent_key, {
        count: 1,
        report_code: parse.report_code,
        fight_id: parse.fight_id,
        player_name: parse.player_name,
        source_id: parse.source_id,
      });
    }
  }

  return [...talentBuilds.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, MAX_TALENT_BUILDS)
    .map(([key, { count, report_code, fight_id, player_name, source_id }]) =>
      ({ key, pct: pct(count, total), report_code, fight_id, player_name, source_id, diff: [] }));
}

/**
 * Roll per-parse trinkets up into the per-slot (12/13) distributions, each slot's
 * top `MAX_TRINKETS_PER_SLOT` trinkets by frequency.
 */
export function aggregateTrinkets(parses: ParseGear[]): EncounterGearStats['trinkets'] {
  const total = parses.length;
  const trinketCounters = new Map<number, Map<number, number>>();
  const trinketNames = new Map<number, string>();
  const trinketIcons = new Map<number, string>();

  for (const parse of parses) {
    for (const trinket of parse.trinkets) {
      const slot = trinket.slot;
      if ((TRINKET_SLOTS as readonly number[]).includes(slot) && trinket.id) {
        const slotMap = getOrInsert(trinketCounters, slot, () => new Map<number, number>());
        slotMap.set(trinket.id, (slotMap.get(trinket.id) ?? 0) + 1);
        // A parse whose name lookup failed stores '', which a later real name replaces.
        if (!trinketNames.get(trinket.id) && trinket.name) trinketNames.set(trinket.id, trinket.name);
        if (!trinketIcons.has(trinket.id)) trinketIcons.set(trinket.id, trinket.icon);
      }
    }
  }

  const trinkets: EncounterGearStats['trinkets'] = {};
  for (const slot of TRINKET_SLOTS) {
    const counter = trinketCounters.get(slot);
    if (!counter?.size) continue;
    trinkets[slot] = [...counter.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_TRINKETS_PER_SLOT)
      .map(([id, count]) => ({ id, name: trinketNames.get(id) ?? '', icon: trinketIcons.get(id) ?? '', pct: pct(count, total) }));
  }
  return trinkets;
}

/**
 * Roll per-parse enchants up into the per-slot distributions (slots ascending),
 * each slot's top `MAX_ENCHANTS_PER_SLOT` enchants by frequency.
 */
export function aggregateEnchants(parses: ParseGear[]): EncounterGearStats['enchants'] {
  const total = parses.length;
  const enchantCounters = new Map<number, Map<number, number>>();
  const enchantNames = new Map<number, string>();

  for (const parse of parses) {
    for (const enchant of parse.enchants) {
      const slot = enchant.slot;
      if (slot != null && enchant.id) {
        const slotMap = getOrInsert(enchantCounters, slot, () => new Map<number, number>());
        slotMap.set(enchant.id, (slotMap.get(enchant.id) ?? 0) + 1);
        // A parse whose name lookup failed stores '', which a later real name replaces.
        if (!enchantNames.get(enchant.id) && enchant.name) enchantNames.set(enchant.id, enchant.name);
      }
    }
  }

  const enchants: EncounterGearStats['enchants'] = {};
  for (const [slot, counter] of [...enchantCounters.entries()].sort((a, b) => a[0] - b[0])) {
    if (!counter.size) continue;
    enchants[slot] = [...counter.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_ENCHANTS_PER_SLOT)
      .map(([id, count]) => ({ id, name: enchantNames.get(id) ?? '', pct: pct(count, total) }));
  }
  return enchants;
}

/** Composes the three per-facet aggregators into the `EncounterGearStats` block. */
export function aggregateParseGear(parses: ParseGear[]): EncounterGearStats {
  return {
    talent_builds: aggregateTalents(parses),
    trinkets: aggregateTrinkets(parses),
    enchants: aggregateEnchants(parses),
  };
}

export function withTalentDiffs(
  builds: EncounterGearStats['talent_builds'], talents: SpecTalents | null,
): EncounterGearStats['talent_builds'] {
  if (!talents || builds.length < 2) return builds;
  const baselineKey = builds[0].key;
  return builds.map((build, i) => i === 0 ? build : { ...build, diff: buildTalentDiff(build.key, baselineKey, talents) });
}

@Injectable({ providedIn: 'root' })
export class GearTransformService implements DataSource<GearBench> {
  private readonly wclApi = inject(WclApiService);
  private readonly talentData = inject(TalentDataService);

  async getBench(spec: string, encounterId: number): Promise<Result<GearBench, LoadError>> {
    try {
      const rankings = toParseRankings(unwrapRankings(await this.wclApi.getRankings(spec, encounterId)), CANDIDATE_POOL_COUNT);
      if (!rankings.length) return missing('Not yet ingested.');

      const parses: ParseGear[] = [];
      let encounterName = '';
      for (const ranking of rankings) {
        const fetched = await this.fetchParseGear(ranking, spec);
        if (!fetched) continue;
        parses.push(fetched.gear);
        encounterName ||= fetched.encounterName;
        if (parses.length >= TOP_PARSE_COUNT) break;
      }
      if (!parses.length) return missing('Not yet ingested.');

      const stats = aggregateParseGear(parses);
      return ok({
        spec,
        encounter_id: encounterId,
        encounter_name: encounterName,
        sample_count: parses.length,
        talent_builds: withTalentDiffs(stats.talent_builds, await this.talentData.getTalents(spec)),
        trinkets: stats.trinkets,
        enchants: stats.enchants,
      });
    } catch (cause) {
      logWarn(`GearTransformService bench ${spec}:${encounterId}`, cause);
      return toLoadError(cause, 'gear.bench');
    }
  }

  /** One parse's gear fingerprint via raw combatant info; null if it can't be fetched. */
  private async fetchParseGear(
    ranking: ParseRanking, spec: string,
  ): Promise<{ gear: ParseGear; encounterName: string } | null> {
    try {
      const report = await this.wclApi.getReport(ranking.report_code);
      const fight = report.fights.find(entry => entry.id === ranking.fight_id);
      const player = report.masterData?.actors?.find(actor => actor.name === ranking.player);
      if (!fight || !player) return null;

      const event = selectCombatantInfo(await this.wclApi.getCombatantInfo(ranking.report_code, fight.id, player.id), player.id);
      if (!event?.gear?.length) return null;

      const { trinkets, enchants } = extractGear(event.gear);
      const itemIds = [...new Set(trinkets.filter(trinket => trinket.id).map(trinket => trinket.id))];
      const enchantIds = [...new Set(enchants.filter(enchant => enchant.id).map(enchant => enchant.id))];
      let names: Record<string, { id: number; name: string }> = {};
      try {
        names = await this.wclApi.getGameNames(itemIds, enchantIds);
      } catch (err) {
        logWarn(`GearTransformService name resolution ${ranking.report_code}:${ranking.fight_id}`, err);
      }
      for (const trinket of trinkets) {
        if (!trinket.name && trinket.id) trinket.name = decodeHtmlEntities(names[`i${trinket.id}`]?.name ?? '');
      }
      for (const enchant of enchants) {
        if (!enchant.name && enchant.id) enchant.name = decodeHtmlEntities(names[`e${enchant.id}`]?.name ?? '');
      }

      const characterGear: CharacterGear = {
        found: true, spec, source_report: ranking.report_code,
        talent_key: talentKeyFromTree(event.talentTree), trinkets, enchants,
      };
      const gear = toParseGear(characterGear, ranking, player.id);
      if (!gear) return null;
      return { gear, encounterName: fight.name ?? '' };
    } catch (err) {
      logWarn(`GearTransformService parse ${ranking.report_code}:${ranking.fight_id}`, err);
      return null;
    }
  }
}
