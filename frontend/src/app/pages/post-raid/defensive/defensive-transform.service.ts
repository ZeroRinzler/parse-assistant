import { Injectable, inject } from '@angular/core';
import { WclApiService } from '../../../core/services/wcl-api';
import { DataFileApiService } from '../../../core/services/data-file-api';
import { RulebookDefensive } from '../../../core/models/rulebook.models';
import { BurstWindow } from '../../../core/models/analysis.models';
import { PerDefensiveBenchmark } from '../../../core/models/encounter.models';
import { Result, missing } from '../../../core/result';
import { mean, deviation, extent, group, mode } from 'd3-array';
import { round, groupByTime, getOrInsert, avgOr, stddevOr, medianOr, castGaps } from '../../../shared/analysis/analysis-math';
import { HoldWindow, buildHoldTargets, detectHoldWindows } from '../../../shared/analysis/hold-targets';
import { buildAuraWindows } from '../../../shared/analysis/aura-windows';
import { TimedEvent, abilityIcons, normalizeAbilityId, relativeS, withRelativeS } from '../../../shared/analysis/wcl-projections';
import { BenchParse, benchFromTopParses, benchHeader } from '../../../shared/analysis/bench-pipeline';
import { DataSource } from '../../../core/data-source/data-source';
import { DefensiveBench, DefensivePlanMeta } from './defensive-data-source';


const CONSENSUS_FRAC = 0.5;
const MEMBER_MAJORITY_FRAC = 0.5;
const CLUSTER_MERGE_S = 20;
const ABILITY_BREAKDOWN_TOP_N = 6;
const NO_DEFENSIVE_BENCH_MESSAGE = 'Not yet ingested.';

export function defensiveSpellIds(defensives: RulebookDefensive[]): Record<string, number> {
  const map: Record<string, number> = {};
  for (const defensive of defensives) if (defensive.spell_id) map[defensive.name] = defensive.spell_id;
  return map;
}

export function defensivePlanMeta(defensives: RulebookDefensive[]): DefensivePlanMeta[] {
  return defensives.map(defensive => ({
    name: defensive.name,
    spell_id: defensive.spell_id,
    cooldown: defensive.cooldown,
    usage_rule: defensive.usage_rule ?? null,
    talent_gated: !!defensive.talent_gated,
  }));
}

export interface ParseDefensiveSummary {
  name: string;
  cast_times_s: number[];
  first_cast_s: number | null;
  uses: number;
  fight_duration_s: number;
  hold_windows: HoldWindow[];
  cast_pattern: 'hold' | 'on_cooldown';
}

export interface ParseDefWindow {
  time_s: number;
  window_length_s: number;
  window_damage: number;
  /** Index of the parse this window came from, so clustering counts DISTINCT parses. */
  parse_index: number;
  defensive_name: string;
  spell_id: number;
  ref_game_id: number | null;
  ability_breakdown: { spell_id: number; damage: number }[];
}

function castTimesOf(spellId: number, castEvents: TimedEvent[]): number[] {
  const times: number[] = [];
  for (const cast of castEvents) {
    if (cast.type === 'cast' && cast.abilityGameID === spellId) times.push(round(cast.atS));
  }
  return times;
}

// Each buff span (or explicit cast for self-buff-less defensives) is one use; hold windows mark casts delayed > 8s past reset.
export function summarizeDefensiveCasts(
  defensives: RulebookDefensive[],
  buffWindows: Map<number, [number, number | null][]>,
  castEvents: TimedEvent[],
  fightDurationS: number,
): ParseDefensiveSummary[] {
  const summaries: ParseDefensiveSummary[] = [];
  for (const defensive of defensives) {
    const spellId = defensive.spell_id;
    const cooldownS = defensive.cooldown;
    const buffTimes = (buffWindows.get(spellId) ?? []).map(buffWindow => round(buffWindow[0]));
    const castTimes = buffTimes.length ? buffTimes : castTimesOf(spellId, castEvents);

    castTimes.sort((a, b) => a - b);
    const holdWindows = detectHoldWindows(castTimes, cooldownS);

    const firstCastS = castTimes[0];
    if (firstCastS != null) {
      summaries.push({
        name: defensive.name,
        cast_times_s: castTimes,
        first_cast_s: firstCastS,
        uses: castTimes.length,
        fight_duration_s: fightDurationS,
        hold_windows: holdWindows,
        cast_pattern: holdWindows.length ? 'hold' : 'on_cooldown',
      });
    }
  }
  return summaries;
}

/** One window hit: `[atS, damage, abilityId, sourceId]` (sorted by time). */
type WindowHit = [number, number, number, number | null];

export function windowDamageBreakdown(windowHits: WindowHit[]): { spell_id: number; damage: number }[] {
  const abilityDmg = new Map<number, number>();
  // Normalize before grouping so raw ids that fold to one spell (melee, synthetic negatives) sum, not split into rows.
  for (const [, damage, abilityId] of windowHits) {
    if (abilityId) {
      const spellId = normalizeAbilityId(abilityId);
      abilityDmg.set(spellId, (abilityDmg.get(spellId) ?? 0) + damage);
    }
  }
  return [...abilityDmg.entries()]
    .sort((a, b) => b[1] - a[1]).slice(0, ABILITY_BREAKDOWN_TOP_N)
    .map(([spell_id, damage]) => ({ spell_id, damage }));
}

function topSourceGameId(windowHits: WindowHit[], gameIdByActorId: Map<number, number>): number | null {
  const dmgBySource = new Map<number, number>();
  for (const [, damage, , sourceId] of windowHits) {
    if (sourceId != null && gameIdByActorId.has(sourceId)) dmgBySource.set(sourceId, (dmgBySource.get(sourceId) ?? 0) + damage);
  }
  const topSource = [...dmgBySource.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return topSource != null ? (gameIdByActorId.get(topSource) ?? null) : null;
}

// Open buffs run to fight end, never a rulebook duration.
export function findParseDefensiveWindows(
  damageTaken: TimedEvent[], fightDurationS: number,
  buffWindows: Map<number, [number, number | null][]>,
  defensives: RulebookDefensive[],
  gameIdByActorId: Map<number, number>,
): ParseDefWindow[] {
  const hits = damageTaken
    .filter(event => event.type === 'damage' && (event.amount ?? 0) + (event.absorbed ?? 0) > 0)
    .map(event => [event.atS, (event.amount ?? 0) + (event.absorbed ?? 0), event.abilityGameID, event.sourceID ?? null] as WindowHit)
    .sort((a, b) => a[0] - b[0]);
  if (!hits.length) return [];

  const result: ParseDefWindow[] = [];
  for (const defensive of defensives) {
    const spellId = defensive.spell_id;

    for (const buffWindow of (buffWindows.get(spellId) ?? [])) {
      const startS = buffWindow[0];
      const endS = buffWindow[1] ?? fightDurationS;
      const windowHits = hits.filter(hit => hit[0] >= startS && hit[0] <= endS);
      const windowDmg = windowHits.reduce((sum, hit) => sum + hit[1], 0);

      result.push({
        time_s: round(startS),
        window_length_s: round(endS - startS),
        window_damage: windowDmg,
        parse_index: 0,
        defensive_name: defensive.name,
        spell_id: spellId,
        ref_game_id: topSourceGameId(windowHits, gameIdByActorId),
        ability_breakdown: windowDamageBreakdown(windowHits),
      });
    }
  }
  return result.sort((a, b) => a.time_s - b.time_s);
}

export function clusterDamageStats(damages: number[]): { dmg_avg: number; dmg_stddev: number; dmg_min: number; dmg_max: number } {
  const [min = 0, max = 0] = extent(damages);
  return {
    dmg_avg: Math.round((mean(damages) ?? 0)),
    dmg_stddev: Math.round((deviation(damages) ?? 0)),
    dmg_min: Math.round(min),
    dmg_max: Math.round(max),
  };
}

export function clusterAbilityBreakdown(cluster: ParseDefWindow[]): BurstWindow['ability_breakdown'] {
  // Sum per parse first so a parse landing an ability across several of its windows counts once toward the gate.
  const damageByAbilityParse = new Map<number, Map<number, number>>();
  for (const member of cluster) {
    for (const ability of member.ability_breakdown) {
      const byParse = getOrInsert(damageByAbilityParse, ability.spell_id, () => new Map<number, number>());
      byParse.set(member.parse_index, (byParse.get(member.parse_index) ?? 0) + ability.damage);
    }
  }
  const distinctParses = new Set(cluster.map(member => member.parse_index)).size;
  return [...damageByAbilityParse.entries()]
    .filter(([, byParse]) => byParse.size >= distinctParses * MEMBER_MAJORITY_FRAC)
    .map(([spell_id, byParse]) => {
      const perParseDamage = [...byParse.values()];
      const [min = 0, max = 0] = extent(perParseDamage);
      return {
        spell_id,
        avg_damage: Math.round((mean(perParseDamage) ?? 0)),
        min_damage: Math.round(min),
        max_damage: Math.round(max),
      };
    })
    .sort((a, b) => b.avg_damage - a.avg_damage)
    .slice(0, ABILITY_BREAKDOWN_TOP_N);
}

function majorityRefGameId(cluster: ParseDefWindow[]): number | null {
  const refs = cluster.map(member => member.ref_game_id).filter(ref => ref != null);
  return refs.length ? mode(refs) : null;
}

export function clusterDefensiveWindows(windows: ParseDefWindow[], sampleCount: number): BurstWindow[] {
  if (!windows.length) return [];
  const byDefensive = group(windows, window => window.defensive_name);

  const minParses = Math.max(2, sampleCount * CONSENSUS_FRAC);
  const result: BurstWindow[] = [];
  for (const [defensiveName, group] of byDefensive.entries()) {
    for (const cluster of groupByTime(group, CLUSTER_MERGE_S)) {
      const distinctParses = new Set(cluster.map(member => member.parse_index)).size;
      const clusterHead = cluster[0];
      if (!clusterHead || distinctParses < minParses) continue;
      const damages = cluster.map(member => member.window_damage);

      result.push({
        time_s: medianOr(cluster.map(member => member.time_s), 0),
        ...clusterDamageStats(damages),
        window_length_s: avgOr(cluster.map(member => member.window_length_s), 0),
        defensive_name: defensiveName,
        spell_id: clusterHead.spell_id,
        common_cds: [defensiveName],
        ref_game_id: majorityRefGameId(cluster),
        ability_breakdown: clusterAbilityBreakdown(cluster),
      });
    }
  }
  return result.sort((a, b) => a.time_s - b.time_s);
}

function usesPerMinStats(summaries: ParseDefensiveSummary[]): PerDefensiveBenchmark['uses_per_min'] {
  const perMin = summaries
    .filter(summary => summary.fight_duration_s > 0 && summary.uses > 0)
    .map(summary => round(summary.uses / summary.fight_duration_s * 60, 3));
  return { avg: avgOr(perMin, 0, 3), stddev: stddevOr(perMin, 0, 3) };
}

// `summaries` is users-only; `totalParses` is every sampled parse, so sample_count and used_sample_count drive the runtime use-share gate.
export function buildDefensiveBenchmark(
  summaries: ParseDefensiveSummary[], effectiveCd: number, totalParses: number,
): PerDefensiveBenchmark {
  const firstCasts = summaries.map(summary => summary.first_cast_s).filter((value): value is number => value != null);
  const gaps = castGaps(summaries);

  return {
    sample_count: totalParses,
    used_sample_count: summaries.length,
    avg_first_cast_s: avgOr(firstCasts, 0),
    stddev_first_cast_s: stddevOr(firstCasts, 0),
    avg_gap_s: avgOr(gaps, null),
    stddev_gap_s: stddevOr(gaps, null),
    hold_targets: buildHoldTargets(summaries, effectiveCd, totalParses),
    median_uses: medianOr(summaries.map(summary => summary.uses), 0),
    uses_per_min: usesPerMinStats(summaries),
    majority_hold: summaries.filter(summary => summary.cast_pattern === 'hold').length > summaries.length * MEMBER_MAJORITY_FRAC,
  };
}

/** Aggregate per-parse summaries into the per-defensive benchmarks. */
export function aggregateDefensiveBenchmarks(
  perParseSummaries: ParseDefensiveSummary[][],
  defensives: RulebookDefensive[],
): Record<string, PerDefensiveBenchmark> {
  const byName = group(perParseSummaries.flat(), summary => summary.name);

  // Every sampled parse contributes one array, so the count is the total-parse use-share denominator.
  const totalParses = perParseSummaries.length;
  const perDefensiveBenchmarks: Record<string, PerDefensiveBenchmark> = {};
  // Iterate the rulebook defensives so the name, cooldown, and spell id come from one source.
  for (const defensive of defensives) {
    const summaries = byName.get(defensive.name);
    if (!summaries?.length) continue; // no sampled parse used this defensive
    perDefensiveBenchmarks[defensive.name] = buildDefensiveBenchmark(summaries, defensive.cooldown, totalParses);
  }
  return perDefensiveBenchmarks;
}

@Injectable({ providedIn: 'root' })
export class DefensiveTransformService implements DataSource<DefensiveBench> {
  private readonly wclApi = inject(WclApiService);
  private readonly dataFiles = inject(DataFileApiService);

  async getBench(spec: string, encounterId: number, partition?: number | null): Promise<Result<DefensiveBench>> {
    const rulebookResult = await this.dataFiles.getRulebook(spec);
    if (!rulebookResult.ok) return rulebookResult;
    const defensives = rulebookResult.value.defensives;
    if (!defensives.length) return missing(NO_DEFENSIVE_BENCH_MESSAGE);

    return benchFromTopParses(this.wclApi, { spec, encounterId, partition }, {
      logSource: 'DefensiveTransformService',
      errorId: 'defensive.bench',
      noRankingsMessage: NO_DEFENSIVE_BENCH_MESSAGE,
      parse: parse => this.parseDefensives(parse, defensives),
      bench: async ({ encounterName, parses }) => {
        const allWindows = parses.flatMap(
          (parse, parseIndex) => parse.windows.map(window => ({ ...window, parse_index: parseIndex })));
        const defensiveWindows = clusterDefensiveWindows(allWindows, parses.length);
        const perDefensiveBenchmarks = aggregateDefensiveBenchmarks(parses.map(parse => parse.summaries), defensives);
        const cd_spell_ids = defensiveSpellIds(defensives);
        // A real icon for every defensive + window ability by id (complete, no fallback).
        const referencedIds = [
          ...Object.values(cd_spell_ids),
          ...defensiveWindows.flatMap(window => window.ability_breakdown.map(ability => ability.spell_id)),
        ];

        return {
          ...benchHeader(spec, encounterId, encounterName, parses.length),
          per_defensive_benchmarks: perDefensiveBenchmarks,
          defensive_windows: defensiveWindows,
          defensives: defensivePlanMeta(defensives),
          cd_spell_ids,
          ability_icons: abilityIcons(await this.wclApi.getAbilities(referencedIds)),
        };
      },
    });
  }

  private async parseDefensives(
    { ranking, report, fight, player }: BenchParse, defensives: RulebookDefensive[],
  ): Promise<{ windows: ParseDefWindow[]; summaries: ParseDefensiveSummary[] }> {
    const gameIdByActorId = new Map<number, number>();
    for (const enemy of report.masterData?.enemies ?? []) gameIdByActorId.set(enemy.id, enemy.gameID);

    const [buffs, casts, dmgTaken] = await Promise.all([
      this.wclApi.getAllEvents(ranking.report_code, fight.id, 'Buffs', fight.startTime, fight.endTime, player.id),
      this.wclApi.getAllEvents(ranking.report_code, fight.id, 'Casts', fight.startTime, fight.endTime, player.id),
      this.wclApi.getAllEvents(ranking.report_code, fight.id, 'DamageTaken', fight.startTime, fight.endTime, player.id),
    ]);

    const fightDurationS = relativeS(fight.endTime, fight.startTime);
    const buffWindows = buildAuraWindows(withRelativeS(buffs, fight.startTime));
    return {
      windows: findParseDefensiveWindows(withRelativeS(dmgTaken, fight.startTime), fightDurationS, buffWindows, defensives, gameIdByActorId),
      summaries: summarizeDefensiveCasts(defensives, buffWindows, withRelativeS(casts, fight.startTime), fightDurationS),
    };
  }
}
