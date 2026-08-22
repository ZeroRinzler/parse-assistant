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

interface UsesPerMin {
  avg: number;
  stddev: number;
}

// A cooldown cast index where a majority of top parses deliberately hold past the natural reset.
interface HoldTarget {
  /** Absolute clock target (median cast time), for display ("hold to 3:20"). */
  target_s: number;
  count: number;
  total_samples: number;
}

// Cascade-free: the band is measured from the player's OWN prior cast, not a cumulative ideal schedule.
interface CdHoldTarget extends HoldTarget {
  /** Prior-relative hold past natural reset (median of actual - (prior + effective_cd_s)). */
  delay_s: number;
  /** Tolerance half-width the runtime compares against: max(delay stddev, floor). */
  band_s: number;
  /** Cadence zero-point used for `delay_s` (nominal rulebook cooldown). */
  effective_cd_s: number;
}

export type CdHoldTargets = Record<string, CdHoldTarget>;

/** The cadence of one pressable ability: its benched timing pattern across the top parses. */
export interface CadenceBenchmark {
  /** Total top parses sampled (NOT users-only, so `used_sample_count` is comparable). */
  sample_count: number;
  /** Parses (of `sample_count`) that used this ability at least once (use-share gate). */
  used_sample_count: number;
  avg_first_cast_s: number;
  stddev_first_cast_s: number;
  avg_gap_s: number | null;
  stddev_gap_s: number | null;
  hold_targets: CdHoldTargets;
  // A median: one outlier parse cannot move it.
  median_uses: number;
  uses_per_min: UsesPerMin;
  /** At least half of the parses that press it hold it (ties count as holds). */
  majority_hold: boolean;
}

export interface PerCdBenchmark extends CadenceBenchmark {
  avg_bl_offset_s: number | null;
  stddev_bl_offset_s: number | null;
  bl_pct: number;
}

export type PerDefensiveBenchmark = CadenceBenchmark;

export interface EncounterGearStats {
  talent_builds: { key: string; pct: number; report_code: string; fight_id: number; player_name: string; source_id: number; diff?: TalentDiff[] }[];
  trinkets: Record<number, { id: number; name: string; icon: string; pct: number }[]>;
  enchants: Record<number, { id: number; name: string; pct: number }[]>;
}
