export interface EncounterEntry {
  id: number;
  name: string;
  sample_count: number;
  last_ingested?: string;
}

export interface PerCdBenchmark {
  avg_first_cast_s: number | null;
  stddev_first_cast_s: number | null;
  avg_uses: number | null;
  avg_uses_per_min: number | null;
  bl_pct: number;
  majority_hold: boolean;
  hold_targets: Record<string, { target_s: number; stddev_s: number; count: number; total_samples: number }>;
  sample_count: number;
}

export interface BurstWindowBench {
  time_s: number;
  pct_avg: number;
  pct_min?: number;
  pct_max?: number;
  pct_stddev?: number;
  common_cds: string[];
  avg_targets: number;
  window_length_s?: number;
  ability_breakdown?: Array<{ spell_id: number; avg_pct: number; min_pct?: number; max_pct?: number; count?: number }>;
}

export interface EncounterBench {
  encounter_id: number;
  encounter_name: string;
  sample_count: number;
  avg_duration_s: number;
  per_cd_benchmarks: Record<string, PerCdBenchmark>;
  burst_windows: BurstWindowBench[];
  defensive_windows?: DefensiveWindowBench[];
  per_defensive_benchmarks?: Record<string, PerDefensiveBenchmark>;
  gear?: EncounterGearStats;
}

export interface DefensiveWindowBench {
  time_s: number;
  stddev_s: number;
  window_length_s?: number;
  count: number;
  total_samples: number;
  pct_avg: number;
  pct_min?: number;
  pct_max?: number;
  pct_stddev?: number;
  common_defensives: string[];
  defensive_name?: string;
  spell_id?: number;
  avg_targets?: number;
  ability_breakdown?: Array<{ spell_id: number; avg_pct: number; min_pct?: number; max_pct?: number; count?: number }>;
}

export interface PerDefensiveBenchmark {
  sample_count: number;
  avg_first_cast_s: number | null;
  stddev_first_cast_s: number | null;
  avg_gap_s: number | null;
  stddev_gap_s: number | null;
  hold_targets: Record<string, { target_s: number; stddev_s: number; count: number; total_samples: number }>;
  avg_uses: number;
  avg_uses_per_min: number | null;
  majority_hold: boolean;
}

export interface EncounterGearStats {
  talent_builds: Array<{ key: string; pct: number; report_code?: string; fight_id?: number; player_name?: string }>;
  trinkets: Record<number, Array<{ id: number; name: string; pct: number }>>;
  enchants: Record<number, Array<{ id: number; name: string; pct: number }>>;
}
