import { InjectionToken } from '@angular/core';
import { DataSource } from '../../../../core/data-source/data-source';
import { BurstWindow } from '../../../../domain/analysis/analysis.models';
import { PerDefensiveBenchmark } from '../../../../domain/encounter/encounter.models';
import { BenchHeader } from '../../../../domain/analysis/bench-pipeline-service';

export interface DefensivePlanMeta {
  name: string;
  spell_id: number;
  cooldown: number;
  usage_rule: string | null;
  talent_gated: boolean;
}

interface BakedAbility {
  icon: string;
  name: string;
}

export interface DefensiveBench extends BenchHeader {
  per_defensive_benchmarks: Record<string, PerDefensiveBenchmark>;
  defensive_windows: BurstWindow[];
  defensives: DefensivePlanMeta[];
  cd_spell_ids: Record<string, number>;
  ability_icons: Record<number, BakedAbility>;
}

export const DEFENSIVE_DATA_SOURCE = new InjectionToken<DataSource<DefensiveBench>>('DEFENSIVE_DATA_SOURCE');
