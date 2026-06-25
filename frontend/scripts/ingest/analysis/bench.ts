/**
 * Transform layer - encounter bench aggregation (pure).
 *
 * Rolls a list of parse samples into the `EncounterBench` file: efficiency
 * thresholds, per-cooldown and per-defensive benchmarks, clustered burst/defensive
 * windows, and gear aggregates. `buildEncounterBench` is the orchestrator; the
 * exported helpers are independently testable.
 */

import { mean, median, stdev, round } from './stats.ts';
import { HOLD_TRIGGER_FRAC, MEMBER_MAJORITY_FRAC } from './thresholds.ts';
import { clusterBurstWindows } from './burst-windows.ts';
import { clusterDefensiveWindows } from './defensive-windows.ts';
import { aggregateGear } from './gear.ts';
import type { RulebookDefensive } from '../../../src/app/core/models/rulebook.models.ts';
import type { CdCastSummary, DefensiveCastSummary, RawBurstWindow, RawDefensiveWindow, ParseSample } from '../models/parse-sample.models.ts';
import type {
  BenchEntry, BaseBenchmark, CdBenchmark, DefensiveSummary, EncounterBench, HoldTarget, UsesPerMin,
} from '../models/bench.models.ts';

const DEFAULT_DOWNTIME_THRESHOLD_MS = 1500;
const DOWNTIME_PERCENTILE = 0.90;

export function benchUsesPerMin(entries: BenchEntry[]): UsesPerMin | Record<string, never> {
  const usesPerMin: number[] = [];
  for (const entry of entries) {
    const duration = entry.fight_duration_s ?? 0;
    const times = entry.cast_times_s ?? [];
    if (duration > 0 && times.length > 0) {
      usesPerMin.push(Math.round(times.length / duration * 60 * 1000) / 1000);
    }
  }
  if (!usesPerMin.length) return {};
  return {
    avg: round(mean(usesPerMin), 3),
    stddev: round(stdev(usesPerMin), 3),
    min: Math.min(...usesPerMin),
    max: Math.max(...usesPerMin),
  };
}

// Per-cast-index hold targets: cast positions where enough top parsers delayed the
// cast, with the median delay players should match. Shared by the cooldown and
// defensive benchmark passes.
export function buildHoldTargets(entries: BenchEntry[]): Record<string, HoldTarget> {
  const holdByCastIdx = new Map<number, number[]>();
  for (const entry of entries) {
    for (const holdWindow of (entry.hold_windows ?? [])) {
      if (!holdByCastIdx.has(holdWindow.cast_index)) holdByCastIdx.set(holdWindow.cast_index, []);
      holdByCastIdx.get(holdWindow.cast_index)!.push(holdWindow.actual_s);
    }
  }
  const holdTargets: Record<string, HoldTarget> = {};
  for (const [castIndex, times] of holdByCastIdx.entries()) {
    if (times.length >= Math.max(2, entries.length * HOLD_TRIGGER_FRAC)) {
      holdTargets[String(castIndex)] = {
        target_s: round(median(times)),
        stddev_s: round(stdev(times)),
        count: times.length,
        total_samples: entries.length,
      };
    }
  }
  return holdTargets;
}

// Benchmark fields common to cooldowns and defensives. `usesOf` reads the per-parse
// use count (cooldowns expose `total_uses`, defensives `uses`); `requireUsesForUpm`
// excludes zero-use parses from the uses-per-minute mean (defensive behavior).
export function buildBaseBenchmark(entries: BenchEntry[], usesOf: (entry: BenchEntry) => number, requireUsesForUpm: boolean): BaseBenchmark {
  const topFirstCasts = entries.map(entry => entry.first_cast_s).filter((value): value is number => value != null);
  const gaps: number[] = [];
  for (const entry of entries) {
    const times = entry.cast_times_s ?? [];
    for (let j = 1; j < times.length; j++) gaps.push(times[j] - times[j - 1]);
  }
  const upmList = entries
    .filter(entry => entry.fight_duration_s && (!requireUsesForUpm || usesOf(entry)))
    .map(entry => usesOf(entry) / (entry.fight_duration_s / 60));
  return {
    sample_count: entries.length,
    avg_first_cast_s: topFirstCasts.length ? round(mean(topFirstCasts)) : 0,
    stddev_first_cast_s: topFirstCasts.length ? round(stdev(topFirstCasts)) : 0,
    avg_gap_s: gaps.length ? round(mean(gaps)) : null,
    stddev_gap_s: gaps.length ? round(stdev(gaps)) : null,
    hold_targets: buildHoldTargets(entries),
    avg_uses: entries.length ? round(mean(entries.map(entry => usesOf(entry) ?? 0))) : 0,
    avg_uses_per_min: upmList.length ? round(mean(upmList), 2) : 0,
    uses_per_min: benchUsesPerMin(entries),
    majority_hold: entries.filter(entry => entry.cast_pattern === 'hold').length > entries.length * MEMBER_MAJORITY_FRAC,
  };
}

// Downtime threshold (p90 of pooled cast gaps) and the top-parse efficiency mean/stddev.
export function computeEfficiencyThresholds(samples: ParseSample[]): { downtimeThresholdMs: number; topAvgEfficiency: number; topEfficiencyStddev: number } {
  const allGapsMs: number[] = [];
  for (const sample of samples) allGapsMs.push(...(sample.cooldown_data.cast_gap_list_ms ?? []));
  allGapsMs.sort((a, b) => a - b);
  let downtimeThresholdMs = DEFAULT_DOWNTIME_THRESHOLD_MS;
  if (allGapsMs.length) {
    const p90Index = Math.max(0, Math.floor(DOWNTIME_PERCENTILE * allGapsMs.length) - 1);
    downtimeThresholdMs = allGapsMs[p90Index];
  }

  const efficiencies: number[] = [];
  for (const sample of samples) {
    const cdData = sample.cooldown_data;
    const gapList = cdData.cast_gap_list_ms ?? [];
    const durationS = cdData.fight_duration_s ?? 0;
    if (gapList.length && durationS > 0) {
      const downtimeS = gapList.filter(gap => gap > downtimeThresholdMs).reduce((sum, gap) => sum + gap, 0) / 1000;
      efficiencies.push(round(Math.max(0, (1 - downtimeS / durationS) * 100)));
    }
  }
  if (!efficiencies.length) {
    for (const sample of samples) {
      const value = sample.cooldown_data.cast_efficiency_pct;
      if (value != null) efficiencies.push(value);
    }
  }

  return {
    downtimeThresholdMs: Math.round(downtimeThresholdMs),
    topAvgEfficiency: efficiencies.length ? round(mean(efficiencies)) : 0,
    topEfficiencyStddev: efficiencies.length ? round(stdev(efficiencies)) : 0,
  };
}

export function aggregateCooldownBenchmarks(samples: ParseSample[]): Record<string, CdBenchmark> {
  const byCd = new Map<string, Array<CdCastSummary & { fight_duration_s: number }>>();
  for (const sample of samples) {
    const cdData = sample.cooldown_data;
    const fightDur = cdData.fight_duration_s ?? 0;
    for (const cooldown of (cdData.cooldowns ?? [])) {
      if (!byCd.has(cooldown.name)) byCd.set(cooldown.name, []);
      byCd.get(cooldown.name)!.push({ ...cooldown, fight_duration_s: fightDur });
    }
  }

  const perCdBenchmarks: Record<string, CdBenchmark> = {};
  for (const [cdName, entries] of byCd.entries()) {
    const blOffsets = entries.map(entry => entry.bl_offset_s).filter((value): value is number => value != null);
    const blCount = entries.filter(entry => entry.bl_aligned).length;
    perCdBenchmarks[cdName] = {
      ...buildBaseBenchmark(entries, entry => (entry as unknown as CdCastSummary).total_uses, false),
      avg_bl_offset_s: blOffsets.length ? round(mean(blOffsets)) : null,
      stddev_bl_offset_s: blOffsets.length ? round(stdev(blOffsets)) : null,
      bl_pct: entries.length ? Math.round(blCount / entries.length * 100) : 0,
    };
  }
  return perCdBenchmarks;
}

export function aggregateDefensiveBenchmarks(
  samples: ParseSample[], specDefensives: RulebookDefensive[],
): { topDefensivesSummary: DefensiveSummary[]; perDefensiveBenchmarks: Record<string, BaseBenchmark> } {
  const usesByName = new Map<string, number[]>();
  for (const sample of samples) {
    for (const defensive of (sample.cooldown_data.defensives ?? [])) {
      if (!usesByName.has(defensive.name)) usesByName.set(defensive.name, []);
      usesByName.get(defensive.name)!.push(defensive.uses ?? 0);
    }
  }

  const topDefensivesSummary: DefensiveSummary[] = [];
  for (const defensive of specDefensives) {
    const uses = usesByName.get(defensive.name);
    if (!uses?.length) continue;
    topDefensivesSummary.push({
      name: defensive.name,
      spell_id: defensive.spell_id,
      avg_uses: round(mean(uses)),
      min_uses: Math.min(...uses),
      max_uses: Math.max(...uses),
      sample_count: uses.length,
    });
  }

  const byDefensive = new Map<string, Array<DefensiveCastSummary & { fight_duration_s: number }>>();
  for (const sample of samples) {
    const cdData = sample.cooldown_data;
    const fightDur = cdData.fight_duration_s ?? 0;
    for (const defensive of (cdData.defensives ?? [])) {
      if (!byDefensive.has(defensive.name)) byDefensive.set(defensive.name, []);
      byDefensive.get(defensive.name)!.push({ ...defensive, fight_duration_s: fightDur });
    }
  }

  const perDefensiveBenchmarks: Record<string, BaseBenchmark> = {};
  for (const [defName, entries] of byDefensive.entries()) {
    perDefensiveBenchmarks[defName] = buildBaseBenchmark(entries, entry => (entry as DefensiveCastSummary).uses, true);
  }

  return { topDefensivesSummary, perDefensiveBenchmarks };
}

// Aggregate already-read parse samples into the encounter bench file payload. Pure:
// no reads or writes. The caller (storage) supplies the spec defensives (from the
// rulebook) and persists the returned object.
export function buildEncounterBench(
  samples: ParseSample[], specDefensives: RulebookDefensive[], spec: string, encounterId: number,
): EncounterBench {
  const encName = samples[0].encounter_name ?? '';
  const { downtimeThresholdMs, topAvgEfficiency, topEfficiencyStddev } = computeEfficiencyThresholds(samples);
  const perCdBenchmarks = aggregateCooldownBenchmarks(samples);

  const durations = samples.map(sample => sample.cooldown_data.fight_duration_s).filter(Boolean) as number[];
  const avgDurationS = durations.length ? round(mean(durations)) : 0;

  const allBurstWindows: RawBurstWindow[] = [];
  for (const sample of samples) {
    for (const burst of (sample.cooldown_data.burst_windows ?? [])) allBurstWindows.push(burst);
  }
  const burstWindowsClustered = allBurstWindows.length ? clusterBurstWindows(allBurstWindows, samples.length) : [];

  const gear = aggregateGear(samples);
  const { topDefensivesSummary, perDefensiveBenchmarks } = aggregateDefensiveBenchmarks(samples, specDefensives);

  const allDefensiveWindows: RawDefensiveWindow[] = [];
  for (const sample of samples) {
    for (const defensiveWindow of (sample.cooldown_data.defensive_windows ?? [])) allDefensiveWindows.push(defensiveWindow);
  }
  const defensiveWindowsClustered = allDefensiveWindows.length ? clusterDefensiveWindows(allDefensiveWindows, samples.length) : [];

  return {
    spec, encounter_id: encounterId, encounter_name: encName,
    sample_count: samples.length,
    avg_duration_s: avgDurationS,
    downtime_threshold_ms: downtimeThresholdMs,
    top_avg_efficiency: topAvgEfficiency,
    top_efficiency_stddev: topEfficiencyStddev,
    per_cd_benchmarks: perCdBenchmarks,
    burst_windows: burstWindowsClustered,
    gear,
    top_defensives_summary: topDefensivesSummary,
    per_defensive_benchmarks: perDefensiveBenchmarks,
    defensive_windows: defensiveWindowsClustered,
  };
}
