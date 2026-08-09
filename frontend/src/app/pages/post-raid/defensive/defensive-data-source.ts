import { InjectionToken } from '@angular/core';
import { DataSource } from '../../../core/data-source/data-source';
import { BurstWindow, TopDefensiveSummary } from '../../../core/models/analysis.models';
import { PerDefensiveBenchmark } from '../../../core/models/encounter.models';

export interface DefensivePlanMeta {
  name: string;
  spell_id: number;
  cooldown: number;
  duration: number | null;
  usage_rule: string | null;
  talent_gated: boolean;
}

export interface BakedAbility {
  icon: string;
  name: string;
}

export interface DefensiveBench {
  spec: string;
  encounter_id: number;
  encounter_name: string;
  sample_count: number;
  per_defensive_benchmarks: Record<string, PerDefensiveBenchmark>;
  defensive_windows: BurstWindow[];
  top_defensives_summary: TopDefensiveSummary[];
  defensives: DefensivePlanMeta[];
  cd_spell_ids: Record<string, number>;
  ability_icons: Record<number, BakedAbility>;
}

export const DEFENSIVE_DATA_SOURCE = new InjectionToken<DataSource<DefensiveBench>>('DEFENSIVE_DATA_SOURCE');
