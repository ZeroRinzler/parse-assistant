import { Injectable, inject } from '@angular/core';
import { WclApiService } from '../../../core/services/wcl-api';
import { CharacterGear, ParseRanking, TopParseSelection } from '../../../core/models/wcl.models';
import { EncounterGearStats } from '../../../core/models/encounter.models';
import { logWarn } from '../../../core/log';
import { Result } from '../../../core/result';
import { GameNames, TRINKET_SLOTS, extractGear, fillGameNames, selectCombatantInfo } from './gear-extract';
import { talentKeyFromTree } from '../../../shared/gear/talent-key';
import { buildTalentDiff } from '../../../shared/gear/gear-comparison';
import { TalentDataService } from '../../../core/transport/talent-data';
import { SpecTalents } from '../../../core/models/talent.models';
import { getOrInsert } from '../../../shared/analysis/analysis-math';
import { BenchParse, benchFromTopParses } from '../../../shared/analysis/bench-pipeline';
import { DataSource } from '../../../core/data-source/data-source';
import { GearBench } from './gear-data-source';

const MAX_TALENT_BUILDS = 3;
const MAX_TRINKETS_PER_SLOT = 5;
const MAX_ENCHANTS_PER_SLOT = 3;

function pct(count: number, total: number): number {
  return total ? Math.round((count / total) * 100) : 0;
}

// The parse identity rides along so each bench talent build can link back to an example parse running it.
export interface ParseGear {
  talent_key: string;
  trinkets: { slot: number; id: number; name: string; icon: string }[];
  enchants: { slot: number; id: number; name: string }[];
  report_code: string;
  fight_id: number;
  player_name: string;
  source_id: number;
}

export function toParseGear(gear: CharacterGear, ranking: ParseRanking, sourceId: number): ParseGear {
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

interface EquippedItem { slot: number; id: number; name: string; icon?: string }

interface SlotTally {
  countsBySlot: Map<number, Map<number, number>>;
  names: Map<number, string>;
  icons: Map<number, string>;
}

function tallyBySlot(items: EquippedItem[]): SlotTally {
  const tally: SlotTally = { countsBySlot: new Map(), names: new Map(), icons: new Map() };
  for (const item of items) {
    if (!item.id) continue;
    const slotMap = getOrInsert(tally.countsBySlot, item.slot, () => new Map<number, number>());
    slotMap.set(item.id, (slotMap.get(item.id) ?? 0) + 1);
    // A parse whose name lookup failed stores '', which a later real name replaces.
    if (!tally.names.get(item.id) && item.name) tally.names.set(item.id, item.name);
    if (!tally.icons.has(item.id)) tally.icons.set(item.id, item.icon ?? '');
  }
  return tally;
}

function topIds(counter: Map<number, number>, limit: number): [number, number][] {
  return [...counter.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

export function aggregateTrinkets(parses: ParseGear[]): EncounterGearStats['trinkets'] {
  const total = parses.length;
  const tally = tallyBySlot(parses.flatMap(parse => parse.trinkets.filter(
    trinket => (TRINKET_SLOTS as readonly number[]).includes(trinket.slot))));

  const trinkets: EncounterGearStats['trinkets'] = {};
  for (const slot of TRINKET_SLOTS) {
    const counter = tally.countsBySlot.get(slot);
    if (!counter?.size) continue;
    trinkets[slot] = topIds(counter, MAX_TRINKETS_PER_SLOT).map(
      ([id, count]) => ({ id, name: tally.names.get(id) ?? '', icon: tally.icons.get(id) ?? '', pct: pct(count, total) }));
  }
  return trinkets;
}

export function aggregateEnchants(parses: ParseGear[]): EncounterGearStats['enchants'] {
  const total = parses.length;
  const tally = tallyBySlot(parses.flatMap(parse => parse.enchants));

  const enchants: EncounterGearStats['enchants'] = {};
  for (const [slot, counter] of [...tally.countsBySlot.entries()].sort((a, b) => a[0] - b[0])) {
    if (!counter.size) continue;
    enchants[slot] = topIds(counter, MAX_ENCHANTS_PER_SLOT).map(
      ([id, count]) => ({ id, name: tally.names.get(id) ?? '', pct: pct(count, total) }));
  }
  return enchants;
}

export function aggregateParseGear(parses: ParseGear[]): EncounterGearStats {
  return {
    talent_builds: aggregateTalents(parses),
    trinkets: aggregateTrinkets(parses),
    enchants: aggregateEnchants(parses),
  };
}

export function withTalentDiffs(
  builds: EncounterGearStats['talent_builds'], talents: Result<SpecTalents>,
): EncounterGearStats['talent_builds'] {
  const baseline = builds[0];
  if (!talents.ok || builds.length < 2 || !baseline) return builds;
  const baselineKey = baseline.key;
  return builds.map((build, i) => i === 0 ? build : { ...build, diff: buildTalentDiff(build.key, baselineKey, talents.value) });
}

@Injectable({ providedIn: 'root' })
export class GearTransformService implements DataSource<GearBench> {
  private readonly wclApi = inject(WclApiService);
  private readonly talentData = inject(TalentDataService);

  async getBench(spec: string, encounterId: number, selection?: TopParseSelection): Promise<Result<GearBench>> {
    return benchFromTopParses(this.wclApi, { spec, encounterId, selection }, {
      logSource: 'GearTransformService',
      errorId: 'gear.bench',
      noRankingsMessage: 'Not yet ingested.',
      parse: parse => this.fetchParseGear(parse),
      bench: async ({ parses }) => {
        const stats = aggregateParseGear(parses);
        return {
          talent_builds: withTalentDiffs(stats.talent_builds, await this.talentData.getTalents(spec)),
          trinkets: stats.trinkets,
          enchants: stats.enchants,
        };
      },
    });
  }

  private async fetchParseGear({ ranking, fight, player }: BenchParse): Promise<ParseGear | null> {
    const event = selectCombatantInfo(await this.wclApi.getCombatantInfo(ranking.report_code, fight.id, player.id), player.id);
    if (!event?.gear?.length) return null;

    const { trinkets, enchants } = extractGear(event.gear);
    const names = await this.resolveGameNames(ranking, trinkets, enchants);
    fillGameNames(trinkets, 'i', names);
    fillGameNames(enchants, 'e', names);

    const characterGear: CharacterGear = {
      talent_key: talentKeyFromTree(event.talentTree), trinkets, enchants,
    };
    return toParseGear(characterGear, ranking, player.id);
  }

  // A failed name lookup leaves the ids intact, so the parse still benches with blank names.
  private async resolveGameNames(
    ranking: ParseRanking, trinkets: { id: number }[], enchants: { id: number }[],
  ): Promise<GameNames> {
    const itemIds = [...new Set(trinkets.filter(trinket => trinket.id).map(trinket => trinket.id))];
    const enchantIds = [...new Set(enchants.filter(enchant => enchant.id).map(enchant => enchant.id))];
    try {
      return await this.wclApi.getGameNames(itemIds, enchantIds);
    } catch (err) {
      logWarn(`GearTransformService name resolution ${ranking.report_code}:${ranking.fight_id}`, err);
      return {};
    }
  }
}
