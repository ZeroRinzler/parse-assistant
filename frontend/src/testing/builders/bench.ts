/**
 * Builders for encounter "bench" (top-parse statistics) fixtures.
 *
 * Real bench files (`data/specs/{spec}/encounters/{id}.json`) are large. A test
 * about, say, "opener later than mean + 2 sigma" only needs one per-cooldown
 * mean and stddev. These factories default *every* field to a benign value
 * (null means / 0 / empty), so a spec sets only the one stat it exercises:
 *
 * ```ts
 * const bk = bench({ perCd: { 'Shadow Blades': { avg_first_cast_s: 3, stddev_first_cast_s: 1 } } });
 * ```
 */
import {
  EncounterBench,
  PerCdBenchmark,
  PerDefensiveBenchmark,
  BurstWindowBench,
  DefensiveWindowBench,
} from '../../app/core/models/encounter.models';

/** A per-cooldown benchmark with everything defaulted; override only what matters. */
export function perCd(partial: Partial<PerCdBenchmark> = {}): PerCdBenchmark {
  return {
    avg_first_cast_s: null,
    stddev_first_cast_s: null,
    avg_gap_s: null,
    stddev_gap_s: null,
    avg_bl_offset_s: null,
    stddev_bl_offset_s: null,
    avg_uses: null,
    avg_uses_per_min: null,
    uses_per_min: { avg: 0, stddev: 0, min: 0, max: 0 },
    bl_pct: 0,
    majority_hold: false,
    hold_targets: {},
    sample_count: 10,
    ...partial,
  };
}

/** A per-defensive benchmark with everything defaulted. */
export function perDefensive(partial: Partial<PerDefensiveBenchmark> = {}): PerDefensiveBenchmark {
  return {
    sample_count: 10,
    avg_first_cast_s: null,
    stddev_first_cast_s: null,
    avg_gap_s: null,
    stddev_gap_s: null,
    hold_targets: {},
    avg_uses: 0,
    avg_uses_per_min: null,
    uses_per_min: { avg: 0, stddev: 0, min: 0, max: 0 },
    majority_hold: false,
    ...partial,
  };
}

export function bench(partial: {
  encounterId?: number;
  encounterName?: string;
  sampleCount?: number;
  avgDurationS?: number;
  downtimeThresholdMs?: number;
  topAvgEfficiency?: number;
  topEfficiencyStddev?: number;
  perCd?: Record<string, Partial<PerCdBenchmark>>;
  perDefensive?: Record<string, Partial<PerDefensiveBenchmark>>;
  burstWindows?: BurstWindowBench[];
  defensiveWindows?: DefensiveWindowBench[];
} = {}): EncounterBench {
  return {
    encounter_id: partial.encounterId ?? 1000,
    encounter_name: partial.encounterName ?? 'Test Boss',
    sample_count: partial.sampleCount ?? 10,
    avg_duration_s: partial.avgDurationS ?? 300,
    downtime_threshold_ms: partial.downtimeThresholdMs,
    top_avg_efficiency: partial.topAvgEfficiency,
    top_efficiency_stddev: partial.topEfficiencyStddev,
    per_cd_benchmarks: Object.fromEntries(
      Object.entries(partial.perCd ?? {}).map(([k, v]) => [k, perCd(v)]),
    ),
    per_defensive_benchmarks: partial.perDefensive
      ? Object.fromEntries(Object.entries(partial.perDefensive).map(([k, v]) => [k, perDefensive(v)]))
      : undefined,
    burst_windows: partial.burstWindows ?? [],
    defensive_windows: partial.defensiveWindows,
  };
}
