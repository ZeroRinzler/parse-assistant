import { TopDefensiveSummary } from './analysis.models';

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
  hold_targets: Record<string, { target_s: number; stddev_s: number; count: number; total_samples: number }>;
  sample_count: number;
}

export interface BurstWindowBench {
  time_s: number;
  dmg_avg: number;
  dmg_min: number;
  dmg_max: number;
  dmg_stddev: number;
  common_cds: string[];
  avg_targets: number;
  window_length_s: number;
  ability_breakdown: { spell_id: number; avg_damage: number; min_damage: number; max_damage: number; count: number; avg_casts?: number }[];
}

export interface EncounterBench {
  spec: string;
  encounter_id: number;
  encounter_name: string;
  sample_count: number;
  avg_duration_s: number;
  downtime_threshold_ms: number;
  top_avg_efficiency: number;
  top_efficiency_stddev: number;
  per_cd_benchmarks: Record<string, PerCdBenchmark>;
  burst_windows: BurstWindowBench[];
  defensive_windows: DefensiveWindowBench[];
  per_defensive_benchmarks: Record<string, PerDefensiveBenchmark>;
  gear: EncounterGearStats;
  top_defensives_summary: TopDefensiveSummary[];
}

export interface DefensiveWindowBench {
  time_s: number;
  stddev_s: number;
  window_length_s: number;
  count: number;
  total_samples: number;
  dmg_avg: number;
  dmg_min: number;
  dmg_max: number;
  dmg_stddev: number;
  common_defensives: string[];
  defensive_name: string;
  spell_id: number;
  avg_targets?: number;
  ability_breakdown: { spell_id: number; avg_damage: number; min_damage: number; max_damage: number; count: number }[];
}

export interface PerDefensiveBenchmark {
  sample_count: number;
  avg_first_cast_s: number;
  stddev_first_cast_s: number;
  avg_gap_s: number | null;
  stddev_gap_s: number | null;
  hold_targets: Record<string, { target_s: number; stddev_s: number; count: number; total_samples: number }>;
  avg_uses: number;
  avg_uses_per_min: number;
  uses_per_min: UsesPerMin;
  majority_hold: boolean;
}

export interface EncounterGearStats {
  talent_builds: { key: string; pct: number; report_code?: string; fight_id?: number; player_name?: string; source_id: number }[];
  trinkets: Record<number, { id: number; name: string; icon: string; pct: number }[]>;
  enchants: Record<number, { id: number; name: string; pct: number }[]>;
}
