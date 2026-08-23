import { InjectionToken } from '@angular/core';
import { DataSource } from '../../../../core/data-source/data-source';
import { PerCdBenchmark } from '../../../../domain/encounter/encounter.models';
import { RulebookCooldown } from '../../../../domain/rulebook/rulebook.models';
import { BenchHeader } from '../../../../domain/analysis/bench-pipeline-service';
import { BenchedRule } from '../domain/rotation-rule-engine-service';

export interface RotationBench extends BenchHeader {
  downtime_threshold_s: number;
  top_avg_efficiency: number;
  top_efficiency_stddev: number;
  per_cd_benchmarks: Record<string, PerCdBenchmark>;
  major_cooldowns: RulebookCooldown[];
  /** Rulebook rules with the band this encounter measured, so the runtime never re-measures the field. */
  rules: BenchedRule[];
  cd_spell_ids: Record<string, number>;
  ability_icons: Record<number, { icon: string; name: string }>;
}

export const ROTATION_DATA_SOURCE = new InjectionToken<DataSource<RotationBench>>('ROTATION_DATA_SOURCE');
