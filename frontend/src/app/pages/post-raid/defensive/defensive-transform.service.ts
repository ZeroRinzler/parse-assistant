/**
 * Live `DataSource<DefensiveBench>`: computes the defensive bench in the browser with its
 * own domain math (it does NOT reference the ingest analysis), mirroring the ingest bench
 * shape. Fetches the top parses, builds per-parse defensive windows + usage summaries,
 * clusters them across parses, and derives the per-defensive benchmarks.
 */
import { Injectable, inject } from '@angular/core';
import { WclApiService } from '../../../core/services/wcl-api';
import { DataFileApiService } from '../../../core/services/data-file-api';
import { ParseRanking, WclReport } from '../../../core/models/wcl.models';
import { RulebookDefensive } from '../../../core/models/rulebook.models';
import { BurstWindow, TopDefensiveSummary } from '../../../core/models/analysis.models';
import { PerDefensiveBenchmark } from '../../../core/models/encounter.models';
import { logWarn } from '../../../core/log';
import { Result, LoadError, ok, missing } from '../../../core/result';
import { toLoadError } from '../../../core/http-load-error';
import { mean, median, deviation } from 'd3-array';
import { round, groupByTime, getOrInsert } from '../../../shared/analysis/analysis-math';
import { HoldWindow, buildHoldTargets, detectHoldWindows } from '../../../shared/analysis/hold-targets';
import { buildAuraWindows } from '../../../shared/analysis/aura-windows';
import { TimedEvent, abilityIcons, normalizeAbilityId, relativeS, toParseRankings, unwrapRankings, withRelativeS } from '../../../shared/analysis/wcl-projections';
import { DataSource } from '../../../core/data-source/data-source';
import { DefensiveBench, DefensivePlanMeta } from './defensive-data-source';

// Re-exported so call sites / specs importing it from the transform service keep working.
export { toParseRankings } from '../../../shared/analysis/wcl-projections';

/** How many top parses to sample (matches the ingest bench). */
const TOP_PARSE_COUNT = 10;
// Over-fetch so a private/unfetchable top parse can be backfilled by the
// next-best one; the break in the loop caps actual fetches at TOP_PARSE_COUNT.
const CANDIDATE_POOL_COUNT = TOP_PARSE_COUNT * 2;
/** A window must appear in at least this share of parses (a majority) to surface. */
const CONSENSUS_FRAC = 0.5;
/** "At least this share of member parses" - ability inclusion in a cluster. */
const MEMBER_MAJORITY_FRAC = 0.5;
/** Defensive windows within this many seconds cluster together. */
const CLUSTER_MERGE_S = 20;
/** Keep only the top-N damage sources in a window's ability breakdown (UI row cap). */
const ABILITY_BREAKDOWN_TOP_N = 6;
/** No ingestable bench (empty rulebook, no top parses, or no fetchable sample); reported as `missing`. */
const NO_DEFENSIVE_BENCH_MESSAGE = 'Not yet ingested.';

/** Defensive name -> spell id, for the defensive window header icons. */
export function defensiveSpellIds(defensives: RulebookDefensive[]): Record<string, number> {
  const map: Record<string, number> = {};
  for (const defensive of defensives) if (defensive.spell_id) map[defensive.name] = defensive.spell_id;
  return map;
}

/** Rulebook defensives -> the static plan metadata carried in the slice. */
export function defensivePlanMeta(defensives: RulebookDefensive[]): DefensivePlanMeta[] {
  return defensives.map(defensive => ({
    name: defensive.name,
    spell_id: defensive.spell_id,
    cooldown: defensive.cooldown,
    duration: defensive.duration ?? null,
    usage_rule: defensive.usage_rule ?? null,
    talent_gated: !!defensive.talent_gated,
  }));
}

/** One parse's defensive usage summary (buff-window-centric, cast fallback). */
export interface ParseDefensiveSummary {
  name: string;
  cast_times_s: number[];
  first_cast_s: number | null;
  uses: number;
  fight_duration_s: number;
  hold_windows: HoldWindow[];
  cast_pattern: 'hold' | 'on_cooldown';
}

/** One parse's defensive window before cross-parse clustering. */
export interface ParseDefWindow {
  time_s: number;
  window_length_s: number;
  window_damage: number;
  /** window_damage as a share of the parse's total damage taken (mitigation magnitude). */
  pct_of_total: number;
  /** Index of the parse this window came from, so clustering counts DISTINCT parses. */
  parse_index: number;
  defensive_name: string;
  spell_id: number;
  ref_game_id: number | null;
  ability_breakdown: { spell_id: number; damage: number }[];
}

/**
 * Per-defensive usage summary for one parse: each buff span (or explicit cast for
 * self-buff-less defensives) is one use; hold windows mark casts delayed > 8s past reset.
 */
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
    const castTimes: number[] = [];

    for (const buffWindow of (buffWindows.get(spellId) ?? [])) castTimes.push(round(buffWindow[0]));

    if (castTimes.length === 0) {
      for (const cast of castEvents) {
        if (cast.type === 'cast' && cast.abilityGameID === spellId) {
          castTimes.push(round(cast.atS));
        }
      }
    }

    castTimes.sort((a, b) => a - b);
    const holdWindows = detectHoldWindows(castTimes, cooldownS);

    if (castTimes.length) {
      summaries.push({
        name: defensive.name,
        cast_times_s: castTimes,
        first_cast_s: castTimes[0],
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

/** Top-N damage sources in a window, summed by normalized spell id, highest damage first. */
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

/**
 * Per-defensive windows for one parse: the measured buff span (open buffs run to fight end,
 * never a rulebook duration), its damage taken, its share of parse total, and dominant enemy.
 */
export function findParseDefensiveWindows(
  damageTaken: TimedEvent[], fightDurationS: number,
  buffWindows: Map<number, [number, number | null][]>,
  defensives: RulebookDefensive[],
  gameIdByActorId: Map<number, number>,
): ParseDefWindow[] {
  const hits = damageTaken
    .filter(event => event.type === 'damage' && (event.amount ?? 0) + (event.absorbed ?? 0) > 0)
    .map(event => [event.atS, (event.amount ?? 0) + (event.absorbed ?? 0), event.abilityGameID ?? 0, event.sourceID ?? null] as WindowHit)
    .sort((a, b) => a[0] - b[0]);
  if (!hits.length) return [];
  const total = hits.reduce((sum, hit) => sum + hit[1], 0);

  const result: ParseDefWindow[] = [];
  for (const defensive of defensives) {
    const spellId = defensive.spell_id;

    for (const buffWindow of (buffWindows.get(spellId) ?? [])) {
      const startS = buffWindow[0];
      const endS = buffWindow[1] != null ? buffWindow[1] : fightDurationS;
      const windowHits = hits.filter(hit => hit[0] >= startS && hit[0] <= endS);
      const windowDmg = windowHits.reduce((sum, hit) => sum + hit[1], 0);

      const ability_breakdown = windowDamageBreakdown(windowHits);

      const dmgBySource = new Map<number, number>();
      for (const [, damage, , sourceId] of windowHits) {
        if (sourceId != null && gameIdByActorId.has(sourceId)) dmgBySource.set(sourceId, (dmgBySource.get(sourceId) ?? 0) + damage);
      }
      const topSource = [...dmgBySource.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      const refGameId = topSource != null ? (gameIdByActorId.get(topSource) ?? null) : null;

      result.push({
        time_s: round(startS),
        window_length_s: round(endS - startS),
        window_damage: windowDmg,
        pct_of_total: total > 0 ? windowDmg / total : 0,
        parse_index: 0,
        defensive_name: defensive.name,
        spell_id: spellId,
        ref_game_id: refGameId,
        ability_breakdown,
      });
    }
  }
  return result.sort((a, b) => a.time_s - b.time_s);
}

/** Absolute damage stats (avg/stddev/min/max, rounded) over a cluster's window damages. */
export function clusterDamageStats(damages: number[]): { dmg_avg: number; dmg_stddev: number; dmg_min: number; dmg_max: number } {
  return {
    dmg_avg: Math.round((mean(damages) ?? 0)),
    dmg_stddev: Math.round((deviation(damages) ?? 0)),
    dmg_min: Math.round(Math.min(...damages)),
    dmg_max: Math.round(Math.max(...damages)),
  };
}

/** Cross-parse top-N ability breakdown: abilities in a majority of distinct parses, avg/min/max, highest avg first. */
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
      return {
        spell_id,
        avg_damage: Math.round((mean(perParseDamage) ?? 0)),
        min_damage: Math.round(Math.min(...perParseDamage)),
        max_damage: Math.round(Math.max(...perParseDamage)),
        count: byParse.size,
      };
    })
    .sort((a, b) => b.avg_damage - a.avg_damage)
    .slice(0, ABILITY_BREAKDOWN_TOP_N);
}

/** Clusters per-parse windows into the bench `BurstWindow[]`, one per consensus of distinct parses. */
export function clusterDefensiveWindows(windows: ParseDefWindow[], sampleCount: number, mergeS = CLUSTER_MERGE_S): BurstWindow[] {
  if (!windows.length) return [];
  const byDefensive = new Map<string, ParseDefWindow[]>();
  for (const window of windows) {
    getOrInsert(byDefensive, window.defensive_name, () => []).push(window);
  }

  const minParses = Math.max(2, sampleCount * CONSENSUS_FRAC);
  const result: BurstWindow[] = [];
  for (const [defensiveName, group] of byDefensive.entries()) {
    for (const cluster of groupByTime(group, mergeS)) {
      // A majority of DISTINCT parses must defend here.
      const distinctParses = new Set(cluster.map(member => member.parse_index)).size;
      if (distinctParses < minParses) continue;
      // Damage-taken share is reported for context (dmg_pct_avg) but does not gate the window.
      const shares = cluster.map(member => member.pct_of_total);
      const damages = cluster.map(member => member.window_damage);

      const refCounts = new Map<number, number>();
      for (const member of cluster) {
        if (member.ref_game_id != null) refCounts.set(member.ref_game_id, (refCounts.get(member.ref_game_id) ?? 0) + 1);
      }
      const ref_game_id = [...refCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

      result.push({
        time_s: round(median(cluster.map(member => member.time_s)) ?? 0),
        ...clusterDamageStats(damages),
        dmg_pct_avg: round((mean(shares) ?? 0), 3),
        window_length_s: round(mean(cluster.map(member => member.window_length_s)) ?? 0),
        defensive_name: defensiveName,
        spell_id: cluster[0].spell_id,
        common_defensives: [defensiveName],
        common_cds: [defensiveName],
        ref_game_id,
        ability_breakdown: clusterAbilityBreakdown(cluster),
      });
    }
  }
  return result.sort((a, b) => a.time_s - b.time_s);
}

/**
 * Cast indices a majority of parses held past reset, with the prior-relative band the runtime
 * compares the player's own gap against. `effectiveCd` is the cooldown (cadence zero-point);
 * `totalParses` is every sampled parse (not users-only), so the consensus denominator matches.
 */

/**
 * Per-defensive benchmark. `summaries` is users-only; `totalParses` is every sampled parse,
 * so `sample_count` (total) and `used_sample_count` (users) drive the runtime use-share gate.
 */
export function buildDefensiveBenchmark(
  summaries: ParseDefensiveSummary[], effectiveCd: number, totalParses: number,
): PerDefensiveBenchmark {
  const firstCasts = summaries.map(summary => summary.first_cast_s).filter((value): value is number => value != null);
  const gaps: number[] = [];
  for (const summary of summaries) {
    const times = summary.cast_times_s;
    for (let j = 1; j < times.length; j++) gaps.push(times[j] - times[j - 1]);
  }
  const usesPerMinList = summaries
    .filter(summary => summary.fight_duration_s && summary.uses)
    .map(summary => summary.uses / (summary.fight_duration_s / 60));
  const benchUsesPerMin = summaries
    .filter(summary => summary.fight_duration_s > 0 && summary.uses > 0)
    .map(summary => round(summary.uses / summary.fight_duration_s * 60, 3));

  return {
    sample_count: totalParses,
    used_sample_count: summaries.length,
    avg_first_cast_s: firstCasts.length ? round((mean(firstCasts) ?? 0)) : 0,
    stddev_first_cast_s: firstCasts.length ? round((deviation(firstCasts) ?? 0)) : 0,
    avg_gap_s: gaps.length ? round((mean(gaps) ?? 0)) : null,
    stddev_gap_s: gaps.length ? round((deviation(gaps) ?? 0)) : null,
    hold_targets: buildHoldTargets(summaries, effectiveCd, totalParses),
    avg_uses: summaries.length ? round(mean(summaries.map(summary => summary.uses)) ?? 0) : 0,
    avg_uses_per_min: usesPerMinList.length ? Math.round((mean(usesPerMinList) ?? 0) * 100) / 100 : 0,
    uses_per_min: benchUsesPerMin.length
      ? {
          avg: round(mean(benchUsesPerMin) ?? 0, 3),
          stddev: round(deviation(benchUsesPerMin) ?? 0, 3),
          min: Math.min(...benchUsesPerMin),
          max: Math.max(...benchUsesPerMin),
        }
      : { avg: 0, stddev: 0, min: 0, max: 0 },
    majority_hold: summaries.filter(summary => summary.cast_pattern === 'hold').length > summaries.length * MEMBER_MAJORITY_FRAC,
  };
}

/** Aggregate per-parse summaries into the per-defensive benchmarks + top-defensives summary. */
export function aggregateDefensiveBenchmarks(
  perParseSummaries: ParseDefensiveSummary[][],
  defensives: RulebookDefensive[],
): { perDefensiveBenchmarks: Record<string, PerDefensiveBenchmark>; topDefensivesSummary: TopDefensiveSummary[] } {
  const byName = new Map<string, ParseDefensiveSummary[]>();
  for (const parse of perParseSummaries) {
    for (const summary of parse) {
      getOrInsert(byName, summary.name, () => []).push(summary);
    }
  }

  // Every sampled parse contributes one array, so the count is the total-parse use-share denominator.
  const totalParses = perParseSummaries.length;
  const perDefensiveBenchmarks: Record<string, PerDefensiveBenchmark> = {};
  const topDefensivesSummary: TopDefensiveSummary[] = [];
  // Iterate the rulebook defensives so the name, cooldown, and spell id come from one source.
  for (const defensive of defensives) {
    const summaries = byName.get(defensive.name);
    if (!summaries?.length) continue; // no sampled parse used this defensive
    perDefensiveBenchmarks[defensive.name] = buildDefensiveBenchmark(summaries, defensive.cooldown, totalParses);
    const uses = summaries.map(summary => summary.uses);
    topDefensivesSummary.push({
      spell_id: defensive.spell_id,
      avg_uses: round((mean(uses) ?? 0)),
      min_uses: Math.min(...uses),
      max_uses: Math.max(...uses),
    });
  }
  return { perDefensiveBenchmarks, topDefensivesSummary };
}

@Injectable({ providedIn: 'root' })
export class DefensiveTransformService implements DataSource<DefensiveBench> {
  private readonly wclApi = inject(WclApiService);
  private readonly dataFiles = inject(DataFileApiService);

  async getBench(spec: string, encounterId: number): Promise<Result<DefensiveBench, LoadError>> {
    const rulebookResult = await this.dataFiles.getRulebook(spec);
    if (!rulebookResult.ok) return rulebookResult;
    const defensives = rulebookResult.value.defensives ?? [];
    if (!defensives.length) return missing(NO_DEFENSIVE_BENCH_MESSAGE);

    try {
      const rankings = toParseRankings(unwrapRankings(await this.wclApi.getRankings(spec, encounterId)), CANDIDATE_POOL_COUNT);
      if (!rankings.length) return missing(NO_DEFENSIVE_BENCH_MESSAGE);

      const allWindows: ParseDefWindow[] = [];
      const perParseSummaries: ParseDefensiveSummary[][] = [];
      let sampleCount = 0;
      let encounterName = '';
      for (const ranking of rankings) {
        const parse = await this.computeParse(ranking, defensives);
        if (!parse) continue;
        for (const window of parse.windows) window.parse_index = sampleCount;
        allWindows.push(...parse.windows);
        perParseSummaries.push(parse.summaries);
        encounterName ||= parse.encounterName;
        sampleCount += 1;
        if (sampleCount >= TOP_PARSE_COUNT) break;
      }
      if (!sampleCount) return missing(NO_DEFENSIVE_BENCH_MESSAGE);

      const defensiveWindows = clusterDefensiveWindows(allWindows, sampleCount);
      const { perDefensiveBenchmarks, topDefensivesSummary } = aggregateDefensiveBenchmarks(perParseSummaries, defensives);
      const cd_spell_ids = defensiveSpellIds(defensives);
      // A real icon for every defensive + window ability by id (complete, no fallback).
      const referencedIds = [
        ...Object.values(cd_spell_ids),
        ...defensiveWindows.flatMap(window => window.ability_breakdown.map(ability => ability.spell_id)),
      ];

      return ok({
        spec,
        encounter_id: encounterId,
        encounter_name: encounterName,
        sample_count: sampleCount,
        per_defensive_benchmarks: perDefensiveBenchmarks,
        defensive_windows: defensiveWindows,
        top_defensives_summary: topDefensivesSummary,
        defensives: defensivePlanMeta(defensives),
        cd_spell_ids,
        ability_icons: abilityIcons(await this.wclApi.getAbilities(referencedIds)),
      });
    } catch (cause) {
      logWarn('DefensiveTransformService.getBench', cause);
      return toLoadError(cause, 'defensive.bench');
    }
  }

  /** One parse's defensive windows + usage summaries via the colocated pure fns; null on fetch failure. */
  private async computeParse(
    ranking: ParseRanking, defensives: RulebookDefensive[],
  ): Promise<{
    windows: ParseDefWindow[];
    summaries: ParseDefensiveSummary[];
    encounterName: string;
  } | null> {
    try {
      const report: WclReport = await this.wclApi.getReport(ranking.report_code);
      const fight = report.fights.find(entry => entry.id === ranking.fight_id);
      const player = report.masterData?.actors?.find(actor => actor.name === ranking.player);
      if (!fight || !player) return null;

      const gameIdByActorId = new Map<number, number>();
      for (const enemy of report.masterData?.enemies ?? []) gameIdByActorId.set(enemy.id, enemy.gameID);

      const [buffs, casts, dmgTaken] = await Promise.all([
        this.wclApi.getAllEvents(ranking.report_code, fight.id, 'Buffs', fight.startTime, fight.endTime, player.id),
        this.wclApi.getAllEvents(ranking.report_code, fight.id, 'Casts', fight.startTime, fight.endTime, player.id),
        this.wclApi.getAllEvents(ranking.report_code, fight.id, 'DamageTaken', fight.startTime, fight.endTime, player.id),
      ]);

      const fightDurationS = relativeS(fight.endTime, fight.startTime);
      const buffWindows = buildAuraWindows(withRelativeS(buffs, fight.startTime));
      const windows = findParseDefensiveWindows(withRelativeS(dmgTaken, fight.startTime), fightDurationS, buffWindows, defensives, gameIdByActorId);
      const summaries = summarizeDefensiveCasts(defensives, buffWindows, withRelativeS(casts, fight.startTime), fightDurationS);
      return { windows, summaries, encounterName: fight.name ?? '' };
    } catch (err) {
      logWarn(`DefensiveTransformService parse ${ranking.report_code}:${ranking.fight_id}`, err);
      return null;
    }
  }
}
