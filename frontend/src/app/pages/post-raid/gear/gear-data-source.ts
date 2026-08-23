import { InjectionToken } from '@angular/core';
import { DataSource } from '../../../core/data-source/data-source';
import { EncounterGearStats } from '../../../core/models/encounter.models';
import { BenchHeader } from '../../../shared/analysis/bench-pipeline';

export interface GearBench extends BenchHeader {
  talent_builds: EncounterGearStats['talent_builds'];
  trinkets: EncounterGearStats['trinkets'];
  enchants: EncounterGearStats['enchants'];
}

export const GEAR_DATA_SOURCE = new InjectionToken<DataSource<GearBench>>('GEAR_DATA_SOURCE');
