/**
 * Live `DataSource<GearBench>`: computes the gear bench live in the browser (no
 * ingestion). Self-contained per the slice rule - it imports ONLY the two API
 * services + models + `logWarn`, and reimplements its own aggregation math below
 * (it does NOT reference the ingest analysis). Bound by `environment.useLiveTransform`.
 *
 * It fetches the encounter's top parses and, for each, refetches the player's
 * combatant-info gear (trinkets, enchants, talent fingerprint) from that parse's
 * log, then rolls the per-parse gear up into talent / trinket / enchant
 * distributions - the same shape the ingest bench writes.
 */
import { Injectable, inject } from '@angular/core';
import { WclApiService } from '../../../core/services/wcl-api';
import { CharacterGear, ParseRanking, WclRawRanking } from '../../../core/models/wcl.models';
import { EncounterGearStats } from '../../../core/models/encounter.models';
import { logWarn } from '../../../core/log';
import { TRINKET_SLOTS, decodeHtmlEntities, extractGear } from './gear-extract';
import { DataSource } from '../../../core/data-source/data-source';
import { GearBench } from './gear-data-source';

// Re-exported from the slice-local projection module so existing call sites /
// specs that import these from the transform service keep working.
export { iconFile, decodeHtmlEntities, extractGear } from './gear-extract';

/** How many top parses to sample (matches the ingest bench). */
const TOP_PARSE_COUNT = 10;
// Over-fetch so a private/unfetchable top parse can be backfilled by the
// next-best one; the break in the loop caps actual fetches at TOP_PARSE_COUNT.
const CANDIDATE_POOL_COUNT = TOP_PARSE_COUNT * 2;
/** Keep at most this many talent builds / trinkets / enchants per slot. */
const MAX_TALENT_BUILDS = 5;
const MAX_TRINKETS_PER_SLOT = 5;
const MAX_ENCHANTS_PER_SLOT = 3;

/* ----------------------------- pure helpers (own math) ----------------------------- */

function pct(count: number, total: number): number {
  return total ? Math.round((count / total) * 100) : 0;
}

// WCL anonymizes a privacy-protected parse's player name to "Character <id>-<id>",
// which can never match a report actor (real names are letters only), so the parse
// is unfetchable. Drop these before mapping.
const ANONYMIZED_NAME = /^Character \d+-\d+$/;

/** Map raw WCL rankings to the top `count` fetchable parses (report + fight + player). */
export function toParseRankings(raw: WclRawRanking[], count: number): ParseRanking[] {
  return raw
    .filter(ranking => ranking.report?.code && !ANONYMIZED_NAME.test(ranking.name ?? ''))
    .slice(0, count)
    .map(ranking => ({
      player: ranking.name ?? '',
      report_code: ranking.report?.code ?? '',
      fight_id: ranking.report?.fightID ?? 0,
    }));
}

/**
 * Build a `v2:`-prefixed talent key from a CombatantInfo `talentTree` array: the
 * sorted (string order, no dedup) nodeIDs, matching ingestion's representation.
 */
export function talentKeyFromTree(tree: { nodeID?: number }[] | undefined): string {
  if (!tree?.length) return '';
  const ids = tree.filter(node => node.nodeID != null).map(node => String(node.nodeID));
  if (!ids.length) return '';
  return 'v2:' + ids.sort().join(',');
}

/**
 * One top parse reduced to just its gear fingerprint (or null when unavailable).
 * The parse identity (`report_code`/`fight_id`/`player_name`) rides along so each
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

/**
 * Reduce a fetched `CharacterGear` to the fields the gear aggregation needs, tagged
 * with the parse identity from its `ranking` (so a build can link to an example parse).
 * `sourceId` is the player's actor id within that report (the WCL `source` deep-link).
 */
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
  const talentCounter = new Map<string, number>();
  const talentExample = new Map<string, { report_code: string; fight_id: number; player_name: string; source_id: number }>();

  for (const parse of parses) {
    if (!parse.talent_key) continue;
    talentCounter.set(parse.talent_key, (talentCounter.get(parse.talent_key) ?? 0) + 1);
    if (!talentExample.has(parse.talent_key)) {
      talentExample.set(parse.talent_key, {
        report_code: parse.report_code,
        fight_id: parse.fight_id,
        player_name: parse.player_name,
        source_id: parse.source_id,
      });
    }
  }

  return [...talentCounter.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_TALENT_BUILDS)
    // talentExample is set in lockstep with talentCounter, so every counted key has an example.
    .map(([key, count]) => ({ key, pct: pct(count, total), ...talentExample.get(key)! }));
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
        if (!trinketCounters.has(slot)) trinketCounters.set(slot, new Map());
        const slotMap = trinketCounters.get(slot)!;
        slotMap.set(trinket.id, (slotMap.get(trinket.id) ?? 0) + 1);
        if (!trinketNames.has(trinket.id)) trinketNames.set(trinket.id, trinket.name ?? '');
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
        if (!enchantCounters.has(slot)) enchantCounters.set(slot, new Map());
        const slotMap = enchantCounters.get(slot)!;
        slotMap.set(enchant.id, (slotMap.get(enchant.id) ?? 0) + 1);
        if (!enchantNames.has(enchant.id)) enchantNames.set(enchant.id, enchant.name ?? '');
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

/**
 * Roll per-parse gear up into bench talent builds, per-slot trinkets (12/13), and
 * per-slot enchants - the `EncounterGearStats` block. Composes the three per-facet
 * aggregators.
 */
export function aggregateParseGear(parses: ParseGear[]): EncounterGearStats {
  return {
    talent_builds: aggregateTalents(parses),
    trinkets: aggregateTrinkets(parses),
    enchants: aggregateEnchants(parses),
  };
}

/* ----------------------------- service shell ----------------------------- */

@Injectable({ providedIn: 'root' })
export class GearTransformService implements DataSource<GearBench> {
  private readonly wclApi = inject(WclApiService);

  async getBench(spec: string, encounterId: number): Promise<GearBench | null> {
    const rankings = toParseRankings(await this.wclApi.getRankings(spec, encounterId), CANDIDATE_POOL_COUNT);
    if (!rankings.length) return null;

    const parses: ParseGear[] = [];
    let encounterName = '';
    for (const ranking of rankings) {
      const fetched = await this.fetchParseGear(ranking, spec);
      if (!fetched) continue;
      parses.push(fetched.gear);
      encounterName ||= fetched.encounterName;
      if (parses.length >= TOP_PARSE_COUNT) break;
    }
    if (!parses.length) return null;

    const stats = aggregateParseGear(parses);
    return {
      spec,
      encounter_id: encounterId,
      encounter_name: encounterName,
      sample_count: parses.length,
      talent_builds: stats.talent_builds,
      trinkets: stats.trinkets,
      enchants: stats.enchants,
    };
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

      const event = await this.wclApi.getCombatantInfo(ranking.report_code, fight.id, player.id);
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
