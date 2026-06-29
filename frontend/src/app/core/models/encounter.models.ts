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
  talent_builds: { key: string; pct: number; report_code: string; fight_id: number; player_name: string; source_id: number }[];
  trinkets: Record<number, { id: number; name: string; icon: string; pct: number }[]>;
  enchants: Record<number, { id: number; name: string; pct: number }[]>;
}
