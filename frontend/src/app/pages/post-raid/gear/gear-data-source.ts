import { InjectionToken } from '@angular/core';
import { DataSource } from '../../../core/data-source/data-source';
import { EncounterGearStats } from '../../../core/models/encounter.models';

export interface GearBench {
  spec: string;
  encounter_id: number;
  encounter_name: string;
  sample_count: number;
  talent_builds: EncounterGearStats['talent_builds'];
  trinkets: EncounterGearStats['trinkets'];
  enchants: EncounterGearStats['enchants'];
}

export const GEAR_DATA_SOURCE = new InjectionToken<DataSource<GearBench>>('GEAR_DATA_SOURCE');
