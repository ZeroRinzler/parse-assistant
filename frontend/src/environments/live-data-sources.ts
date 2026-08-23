/** Never import from `environment.ts`: these `*TransformService` references must stay out of the production graph. */
import { Provider } from '@angular/core';
import { provideLiveDataSource } from '../app/core/data-source/provide-data-source';
import { BURST_DATA_SOURCE } from '../app/features/raid-analysis/burst-windows/data-access/burst-data-source';
import { BurstTransformService } from '../app/features/raid-analysis/burst-windows/data-access/burst-transform-service';
import { ROTATION_DATA_SOURCE } from '../app/features/raid-analysis/rotation/data-access/rotation-data-source';
import { RotationTransformService } from '../app/features/raid-analysis/rotation/data-access/rotation-transform-service';
import { DEFENSIVE_DATA_SOURCE } from '../app/features/raid-analysis/defensive/data-access/defensive-data-source';
import { DefensiveTransformService } from '../app/features/raid-analysis/defensive/data-access/defensive-transform-service';
import { GEAR_DATA_SOURCE } from '../app/features/raid-analysis/gear/data-access/gear-data-source';
import { GearTransformService } from '../app/features/raid-analysis/gear/data-access/gear-transform-service';
import { MAP_DATA_SOURCE } from '../app/features/raid-analysis/map/data-access/map-data-source';
import { MapTransformService } from '../app/features/raid-analysis/map/data-access/map-transform-service';
import { NORTHERN_SKY_DATA_SOURCE } from '../app/features/raid-analysis/northern-sky/data-access/northern-sky-data-source';
import { NorthernSkyTransformService } from '../app/features/raid-analysis/northern-sky/data-access/northern-sky-transform-service';

export const liveDataSourceProviders: Provider[] = [
  provideLiveDataSource(BURST_DATA_SOURCE, BurstTransformService),
  provideLiveDataSource(ROTATION_DATA_SOURCE, RotationTransformService),
  provideLiveDataSource(DEFENSIVE_DATA_SOURCE, DefensiveTransformService),
  provideLiveDataSource(GEAR_DATA_SOURCE, GearTransformService),
  provideLiveDataSource(MAP_DATA_SOURCE, MapTransformService),
  provideLiveDataSource(NORTHERN_SKY_DATA_SOURCE, NorthernSkyTransformService),
];
