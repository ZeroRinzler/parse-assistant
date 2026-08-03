import { TalentDiff } from './talent.models';

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
 * deliberately hold past the natural reset. `target_s` is the absolute clock median,
 * which the plan surfaces for display; `count`/`total_samples` drive the "X/Y hold" copy.
 */
export interface HoldTarget {
  /** Absolute clock target (median cast time), for display ("hold to 3:20"). */
  target_s: number;
  /** Std-dev of the absolute target. */
  stddev_s: number;
  count: number;
  total_samples: number;
}

/**
 * Hold target with the prior-relative band the runtime compares the player's own gap
 * against (cascade-free: measured from the player's OWN prior cast, not a cumulative
 * ideal schedule). Both the rotation and defensive benches write these.
 */
export interface CdHoldTarget extends HoldTarget {
  /** Prior-relative hold past natural reset (median of actual - (prior + effective_cd_s)). */
  delay_s: number;
  /** Std-dev of `delay_s`. */
  delay_stddev_s: number;
  /** Tolerance half-width the runtime compares against: max(delay_stddev_s, floor). */
  band_s: number;
  /** Cadence zero-point used for `delay_s` (nominal rulebook cooldown). */
  effective_cd_s: number;
}

/** Rotation + defensive hold targets (base + prior-relative band). */
export type CdHoldTargets = Record<string, CdHoldTarget>;

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
  hold_targets: CdHoldTargets;
  /** Total top parses sampled for this cooldown. */
  sample_count: number;
  /**
   * Parses (of `sample_count`) that used this cooldown at least once. Drives the
   * use-share gate: the lost/unused critical and the first-cast-delay warning fire only
   * when a majority of top parses actually used the ability, so a situational cd most
   * top parses skip is not flagged as "unused".
   */
  used_sample_count: number;
}

export interface PerDefensiveBenchmark {
  /** Total top parses sampled (NOT users-only, so `used_sample_count` is comparable). */
  sample_count: number;
  /** Parses (of `sample_count`) that used this defensive at least once (use-share gate). */
  used_sample_count: number;
  avg_first_cast_s: number;
  stddev_first_cast_s: number;
  avg_gap_s: number | null;
  stddev_gap_s: number | null;
  hold_targets: CdHoldTargets;
  avg_uses: number;
  avg_uses_per_min: number;
  uses_per_min: UsesPerMin;
  majority_hold: boolean;
}

export interface EncounterGearStats {
  talent_builds: { key: string; pct: number; report_code: string; fight_id: number; player_name: string; source_id: number; diff: TalentDiff[] }[];
  trinkets: Record<number, { id: number; name: string; icon: string; pct: number }[]>;
  enchants: Record<number, { id: number; name: string; pct: number }[]>;
}
