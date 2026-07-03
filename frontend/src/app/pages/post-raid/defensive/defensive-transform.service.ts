/**
 * Live `DataSource<DefensiveBench>`: computes the defensive bench live in the browser
 * (no ingestion). Self-contained per the slice rule - it imports the two API
 * services + models + `logWarn` (plus generic `d3-array` stats and the blessed
 * `shared/analysis/analysis-math` primitives such as `round`/`groupByTime`), and
 * reimplements its own defensive DOMAIN math below (it does NOT reference the ingest
 * analysis). Bound by `environment.useLiveTransform`.
 *
 * It fetches the encounter's top parses, refetches each parse's Buffs + DamageTaken
 * (and Casts as the no-self-buff fallback), builds per-parse buff-window-centric
 * defensive windows + usage summaries, then clusters them across parses and derives
 * the per-defensive benchmarks. Bench shape mirrors the ingest `DefensiveSliceFile`.
 */
import { Injectable, inject } from '@angular/core';
import { WclApiService } from '../../../core/services/wcl-api';
import { DataFileApiService } from '../../../core/services/data-file-api';
import { WclEvent, ParseRanking, WclReport } from '../../../core/models/wcl.models';
import { RulebookDefensive } from '../../../core/models/rulebook.models';
import { BurstWindow, TopDefensiveSummary } from '../../../core/models/analysis.models';
import { PerDefensiveBenchmark, CdHoldTargets } from '../../../core/models/encounter.models';
import { logWarn } from '../../../core/log';
import { mean, median, deviation } from 'd3-array';
import { round, groupByTime, getOrInsert } from '../../../shared/analysis/analysis-math';
import { abilityIcons, toParseRankings, unwrapRankings } from '../../../shared/analysis/wcl-projections';
import { DataSource } from '../../../core/data-source/data-source';
import { DefensiveBench, DefensivePlanMeta } from './defensive-data-source';

// Re-exported from the shared blessed module so call sites / specs that import it
// from the transform service keep working.
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
/** Fraction of samples that must have held at a cast index to surface a hold target. */
const HOLD_TRIGGER_FRAC = 0.4;
/** A gap beyond this past the expected on-cooldown time counts as a deliberate hold. */
const HOLD_THRESHOLD_S = 8;
/** Floor on the runtime hold tolerance band half-width, so a tight cluster still tolerates jitter. */
const HOLD_BAND_MIN_S = 5.0;
/** Keep only the top-N damage sources in a window's ability breakdown (UI row cap). */
const ABILITY_BREAKDOWN_TOP_N = 6;

/* ----------------------------- pure helpers (own math) ----------------------------- */

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

/** Map<spell_id, [[start_s, end_s | null], ...]> from the buff apply/remove stream. */
export function buildBuffWindows(buffEvents: WclEvent[], fightStartMs: number): Map<number, [number, number | null][]> {
  const buffWindows = new Map<number, [number, number | null][]>();
  for (const event of buffEvents) {
    const spellId = event.abilityGameID;
    if (spellId == null) continue;
    const timeS = (event.timestamp - fightStartMs) / 1000;
    if (event.type === 'applybuff') {
      getOrInsert(buffWindows, spellId, () => []).push([timeS, null]);
    } else if (event.type === 'removebuff') {
      const windows = buffWindows.get(spellId) ?? [];
      for (let i = windows.length - 1; i >= 0; i--) {
        if (windows[i][1] == null) { windows[i][1] = timeS; break; }
      }
    }
  }
  return buffWindows;
}

/** One parse's defensive usage summary (buff-window-centric, cast fallback). */
export interface ParseDefensiveSummary {
  name: string;
  cast_times_s: number[];
  first_cast_s: number | null;
  uses: number;
  fight_duration_s: number;
  hold_windows: { cast_index: number; actual_s: number; delay_s: number }[];
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
 * Per-defensive usage summary for one parse: each apply->remove buff span (or
 * explicit cast for self-buff-less defensives) is one use; hold windows mark casts
 * delayed > 8s past on-cooldown.
 */
export function summarizeDefensiveCasts(
  defensives: RulebookDefensive[],
  buffWindows: Map<number, [number, number | null][]>,
  castEvents: WclEvent[],
  fightStartMs: number,
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
          castTimes.push(round((cast.timestamp - fightStartMs) / 1000));
        }
      }
    }

    castTimes.sort((a, b) => a - b);
    // cast_index is 1-based (the ordinal of the held cast), matching the rotation slice and the
    // runtime's `parseInt(idx) - 1` decode. delay_s is the prior-relative hold past the natural
    // reset, so the runtime compares the player's own gap (cascade-free).
    const holdWindows: { cast_index: number; actual_s: number; delay_s: number }[] = [];
    for (let castIndex = 1; castIndex < castTimes.length; castIndex++) {
      const expectedS = castTimes[castIndex - 1] + cooldownS;
      const actualS = castTimes[castIndex];
      const delayS = actualS - expectedS;
      if (delayS > HOLD_THRESHOLD_S) holdWindows.push({ cast_index: castIndex + 1, actual_s: round(actualS), delay_s: round(delayS) });
    }

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

/** One window hit: `[timestampMs, damage, abilityId, sourceId]` (sorted by time). */
type WindowHit = [number, number, number, number | null];

/** Top-N damage sources in a window, summed by ability id, highest damage first. */
export function windowDamageBreakdown(windowHits: WindowHit[]): { spell_id: number; damage: number }[] {
  const abilityDmg = new Map<number, number>();
  for (const [, damage, abilityId] of windowHits) {
    if (abilityId) abilityDmg.set(abilityId, (abilityDmg.get(abilityId) ?? 0) + damage);
  }
  return [...abilityDmg.entries()]
    .sort((a, b) => b[1] - a[1]).slice(0, ABILITY_BREAKDOWN_TOP_N)
    .map(([spell_id, damage]) => ({ spell_id, damage }));
}

/**
 * Per-defensive windows for one parse: the MEASURED buff span (apply -> remove, or to
 * fight end for an open buff - never a rulebook duration) with the damage taken during
 * it, its share of the parse's total damage taken, and the dominant enemy.
 */
export function findParseDefensiveWindows(
  damageTaken: WclEvent[], fightStartMs: number, fightDurationS: number,
  buffWindows: Map<number, [number, number | null][]>,
  defensives: RulebookDefensive[],
  gameIdByActorId: Map<number, number>,
): ParseDefWindow[] {
  const hits = damageTaken
    .filter(event => event.type === 'damage' && (event.amount ?? 0) + (event.absorbed ?? 0) > 0)
    .map(event => [event.timestamp, (event.amount ?? 0) + (event.absorbed ?? 0), event.abilityGameID ?? 0, event.sourceID ?? null] as WindowHit)
    .sort((a, b) => a[0] - b[0]);
  if (!hits.length) return [];
  const total = hits.reduce((sum, hit) => sum + hit[1], 0);

  const result: ParseDefWindow[] = [];
  for (const defensive of defensives) {
    const spellId = defensive.spell_id;

    for (const buffWindow of (buffWindows.get(spellId) ?? [])) {
      const startS = buffWindow[0];
      const endS = buffWindow[1] != null ? buffWindow[1] : fightDurationS;
      const startMs = fightStartMs + startS * 1000;
      const endMs = fightStartMs + endS * 1000;
      const windowHits = hits.filter(hit => hit[0] >= startMs && hit[0] <= endMs);
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

/**
 * Cross-parse top-N ability breakdown for a cluster: each ability present in at least
 * a majority of member parses, with its avg/min/max damage, highest avg first.
 */
export function clusterAbilityBreakdown(cluster: ParseDefWindow[]): BurstWindow['ability_breakdown'] {
  const abilityDamage = new Map<number, number[]>();
  for (const member of cluster) {
    for (const ability of member.ability_breakdown) {
      getOrInsert(abilityDamage, ability.spell_id, () => []).push(ability.damage);
    }
  }
  return [...abilityDamage.entries()]
    .filter(([, list]) => list.length >= cluster.length * MEMBER_MAJORITY_FRAC)
    .map(([spell_id, list]) => ({
      spell_id,
      avg_damage: Math.round((mean(list) ?? 0)),
      min_damage: Math.round(Math.min(...list)),
      max_damage: Math.round(Math.max(...list)),
      count: list.length,
    }))
    .sort((a, b) => b.avg_damage - a.avg_damage)
    .slice(0, ABILITY_BREAKDOWN_TOP_N);
}

/**
 * Cluster per-parse defensive windows across parses into the bench `BurstWindow[]`.
 * Surfaces a window wherever a MAJORITY of distinct parses defended (consensus);
 * incoming damage taken is reported for context but no longer gates the window.
 */
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
      // Consensus: a majority of DISTINCT parses must defend here.
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
 * Cast indices where a majority of parses deliberately held past the natural reset, with the
 * prior-relative band the runtime compares the player's own gap against (mirrors the rotation
 * slice, cascade-free). `effectiveCd` is the defensive's cooldown (the cadence zero-point);
 * `totalParses` is every sampled parse (not users-only), so the consensus denominator and the
 * "X/Y hold" copy match rotation.
 */
export function buildHoldTargets(
  summaries: ParseDefensiveSummary[], effectiveCd: number, totalParses: number,
): CdHoldTargets {
  const byIndex = new Map<number, { actuals: number[]; delays: number[] }>();
  for (const summary of summaries) {
    for (const hold of summary.hold_windows) {
      const bucket = getOrInsert(byIndex, hold.cast_index, () => ({ actuals: [] as number[], delays: [] as number[] }));
      bucket.actuals.push(hold.actual_s);
      bucket.delays.push(hold.delay_s);
    }
  }
  const holdTargets: CdHoldTargets = {};
  for (const [castIndex, { actuals, delays }] of byIndex.entries()) {
    if (actuals.length >= Math.max(2, totalParses * HOLD_TRIGGER_FRAC)) {
      const delayStddev = round(deviation(delays) ?? 0);
      holdTargets[String(castIndex)] = {
        target_s: round((median(actuals) ?? 0)),
        stddev_s: round((deviation(actuals) ?? 0)),
        delay_s: round((median(delays) ?? 0)),
        delay_stddev_s: delayStddev,
        band_s: round(Math.max(delayStddev, HOLD_BAND_MIN_S)),
        effective_cd_s: round(effectiveCd),
        count: actuals.length,
        total_samples: totalParses,
      };
    }
  }
  return holdTargets;
}

/**
 * Per-defensive benchmark from a defensive's per-parse summaries. `summaries` is users-only
 * (parses that pressed it at least once); `totalParses` is every sampled parse, so
 * `sample_count` (total) and `used_sample_count` (users) drive the runtime use-share gate.
 * `effectiveCd` is the defensive's cooldown (the hold-band cadence zero-point).
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
    .map(summary => Math.round(summary.uses / summary.fight_duration_s * 60 * 1000) / 1000);

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
          avg: Math.round((mean(benchUsesPerMin) ?? 0) * 1000) / 1000,
          stddev: Math.round((deviation(benchUsesPerMin) ?? 0) * 1000) / 1000,
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

  // Every sampled parse contributes one array (possibly empty for a defensive it never used),
  // so the array count is the total parse count - the use-share denominator for each defensive.
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

/* ----------------------------- service shell ----------------------------- */

@Injectable({ providedIn: 'root' })
export class DefensiveTransformService implements DataSource<DefensiveBench> {
  private readonly wclApi = inject(WclApiService);
  private readonly dataFiles = inject(DataFileApiService);

  async getBench(spec: string, encounterId: number): Promise<DefensiveBench | null> {
    const rulebook = await this.dataFiles.getRulebook(spec);
    const defensives = rulebook?.defensives ?? [];
    if (!defensives.length) return null;

    const rankings = toParseRankings(unwrapRankings(await this.wclApi.getRankings(spec, encounterId)), CANDIDATE_POOL_COUNT);
    if (!rankings.length) return null;

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
    if (!sampleCount) return null;

    const defensiveWindows = clusterDefensiveWindows(allWindows, sampleCount);
    const { perDefensiveBenchmarks, topDefensivesSummary } = aggregateDefensiveBenchmarks(perParseSummaries, defensives);
    const cd_spell_ids = defensiveSpellIds(defensives);
    // Resolve a real icon for every defensive + window ability by id (complete, no fallback).
    const referencedIds = [
      ...Object.values(cd_spell_ids),
      ...defensiveWindows.flatMap(window => window.ability_breakdown.map(ability => ability.spell_id)),
    ];

    return {
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
    };
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

      const fightDurationS = (fight.endTime - fight.startTime) / 1000;
      const buffWindows = buildBuffWindows(buffs, fight.startTime);
      const windows = findParseDefensiveWindows(dmgTaken, fight.startTime, fightDurationS, buffWindows, defensives, gameIdByActorId);
      const summaries = summarizeDefensiveCasts(defensives, buffWindows, casts, fight.startTime, fightDurationS);
      return { windows, summaries, encounterName: fight.name ?? '' };
    } catch (err) {
      logWarn(`DefensiveTransformService parse ${ranking.report_code}:${ranking.fight_id}`, err);
      return null;
    }
  }
}
