import { InjectionToken } from '@angular/core';
import { DataSource } from '../../../../core/data-source/data-source';
import { EncounterGearStats } from '../../../../domain/encounter/encounter.models';
import { BenchHeader } from '../../../../domain/analysis/bench-pipeline-service';

export interface GearBench extends BenchHeader {
  talent_builds: EncounterGearStats['talent_builds'];
  trinkets: EncounterGearStats['trinkets'];
  enchants: EncounterGearStats['enchants'];
}

export const GEAR_DATA_SOURCE = new InjectionToken<DataSource<GearBench>>('GEAR_DATA_SOURCE');
