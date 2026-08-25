import { InjectionToken } from '@angular/core';
import { DataSource } from '../../core/data-source/data-source';
import { EncounterGearStats } from '../encounter/encounter.models';
import { BenchHeader } from '../analysis/bench-pipeline-service';

// Lives in domain/ (not the gear slice's data-access) because the talents slice reads this same ingested bench.
export interface GearBench extends BenchHeader {
  talent_builds: EncounterGearStats['talent_builds'];
  trinkets: EncounterGearStats['trinkets'];
  enchants: EncounterGearStats['enchants'];
  avg_stats?: EncounterGearStats['avg_stats'];
  avg_item_level?: EncounterGearStats['avg_item_level'];
}

export const GEAR_DATA_SOURCE = new InjectionToken<DataSource<GearBench>>('GEAR_DATA_SOURCE');
