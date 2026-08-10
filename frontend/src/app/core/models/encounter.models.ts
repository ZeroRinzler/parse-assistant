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

// A cooldown cast index where a majority of top parses deliberately hold past the natural reset.
export interface HoldTarget {
  /** Absolute clock target (median cast time), for display ("hold to 3:20"). */
  target_s: number;
  stddev_s: number;
  count: number;
  total_samples: number;
}

// Cascade-free: the band is measured from the player's OWN prior cast, not a cumulative ideal schedule.
export interface CdHoldTarget extends HoldTarget {
  /** Prior-relative hold past natural reset (median of actual - (prior + effective_cd_s)). */
  delay_s: number;
  delay_stddev_s: number;
  /** Tolerance half-width the runtime compares against: max(delay_stddev_s, floor). */
  band_s: number;
  /** Cadence zero-point used for `delay_s` (nominal rulebook cooldown). */
  effective_cd_s: number;
}

export type CdHoldTargets = Record<string, CdHoldTarget>;

export interface PerCdBenchmark {
  avg_first_cast_s: number;
  stddev_first_cast_s: number;
  avg_gap_s: number | null;
  stddev_gap_s: number | null;
  avg_bl_offset_s: number | null;
  stddev_bl_offset_s: number | null;
  avg_uses: number;
  // A median, unlike avg_uses: one outlier parse cannot move it.
  median_uses: number;
  avg_uses_per_min: number;
  uses_per_min: UsesPerMin;
  bl_pct: number;
  majority_hold: boolean;
  hold_targets: CdHoldTargets;
  sample_count: number;
  // Drives the use-share gate, so a situational cd most top parses skip is not flagged as "unused".
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
  // A median, unlike avg_uses: one outlier parse cannot move it.
  median_uses: number;
  avg_uses_per_min: number;
  uses_per_min: UsesPerMin;
  majority_hold: boolean;
}

export interface EncounterGearStats {
  talent_builds: { key: string; pct: number; report_code: string; fight_id: number; player_name: string; source_id: number; diff: TalentDiff[] }[];
  trinkets: Record<number, { id: number; name: string; icon: string; pct: number }[]>;
  enchants: Record<number, { id: number; name: string; pct: number }[]>;
}
