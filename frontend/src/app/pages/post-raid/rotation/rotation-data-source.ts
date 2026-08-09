import { InjectionToken } from '@angular/core';
import { DataSource } from '../../../core/data-source/data-source';
import { PerCdBenchmark } from '../../../core/models/encounter.models';
import { RulebookCooldown } from '../../../core/models/rulebook.models';
import { BenchedRule } from './rotation-rules';

export interface RotationBench {
  spec: string;
  encounter_id: number;
  encounter_name: string;
  sample_count: number;
  avg_duration_s: number;
  downtime_threshold_s: number;
  top_avg_efficiency: number;
  top_efficiency_stddev: number;
  per_cd_benchmarks: Record<string, PerCdBenchmark>;
  major_cooldowns: RulebookCooldown[];
  /** Rulebook rules with the magnitude this encounter measured, so the runtime never re-measures the field. */
  rules: BenchedRule[];
  cd_spell_ids: Record<string, number>;
  ability_icons: Record<number, { icon: string; name: string }>;
}

export const ROTATION_DATA_SOURCE = new InjectionToken<DataSource<RotationBench>>('ROTATION_DATA_SOURCE');
