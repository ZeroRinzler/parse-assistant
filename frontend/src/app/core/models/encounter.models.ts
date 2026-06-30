export interface SpecEntry {
  spec: string;
  encounter_count: number;
}

export interface EncounterEntry {
  id: number;
  name: string;
  sample_count: number;
}

export interface UsesPerMin {
  avg: number;
  stddev: number;
  min: number;
  max: number;
}

/**
 * Per-cast-index hold target: a cooldown cast index where a majority of top parses
 * deliberately hold past the natural reset. `target_s` is the absolute clock median
 * (display); the `delay_*`/`band_s`/`effective_cd_s` group is the prior-relative
 * measurement the runtime compares against (cascade-free).
 *
 * The four prior-relative fields are TEMPORARILY OPTIONAL during the v2 ingest
 * migration: v2 data always writes them, but pre-v2 tailored files lack them, so the
 * runtime guards their absence. PR2 (after the full re-ingest) makes them required.
 */
export interface HoldTarget {
  /** Absolute clock target (median cast time), for display ("hold to 3:20"). */
  target_s: number;
  /** Std-dev of the absolute target. */
  stddev_s: number;
  /** Prior-relative hold past natural reset (median of actual - (prior + effective_cd_s)). */
  delay_s?: number;
  /** Std-dev of `delay_s`. */
  delay_stddev_s?: number;
  /** Tolerance half-width the runtime compares against: max(delay_stddev_s, floor). */
  band_s?: number;
  /** Cadence zero-point used for `delay_s` (nominal rulebook cooldown). */
  effective_cd_s?: number;
  count: number;
  total_samples: number;
}

export type HoldTargets = Record<string, HoldTarget>;

export interface PerCdBenchmark {
  avg_first_cast_s: number;
  stddev_first_cast_s: number;
  avg_gap_s: number | null;
  stddev_gap_s: number | null;
  avg_bl_offset_s: number | null;
  stddev_bl_offset_s: number | null;
  avg_uses: number;
  avg_uses_per_min: number;
  uses_per_min: UsesPerMin;
  bl_pct: number;
  majority_hold: boolean;
  hold_targets: HoldTargets;
  sample_count: number;
}

export interface PerDefensiveBenchmark {
  sample_count: number;
  avg_first_cast_s: number;
  stddev_first_cast_s: number;
  avg_gap_s: number | null;
  stddev_gap_s: number | null;
  hold_targets: HoldTargets;
  avg_uses: number;
  avg_uses_per_min: number;
  uses_per_min: UsesPerMin;
  majority_hold: boolean;
}

export interface EncounterGearStats {
  talent_builds: { key: string; pct: number; report_code: string; fight_id: number; player_name: string; source_id: number }[];
  trinkets: Record<number, { id: number; name: string; icon: string; pct: number }[]>;
  enchants: Record<number, { id: number; name: string; pct: number }[]>;
}
