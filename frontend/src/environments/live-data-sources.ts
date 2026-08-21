/** Never import from `environment.ts`: these `*TransformService` references must stay out of the production graph. */
import { Provider } from '@angular/core';
import { provideLiveDataSource } from '../app/core/data-source/provide-data-source';
import { BURST_DATA_SOURCE } from '../app/pages/post-raid/burst-windows/burst-data-source';
import { BurstTransformService } from '../app/pages/post-raid/burst-windows/burst-transform.service';
import { ROTATION_DATA_SOURCE } from '../app/pages/post-raid/rotation/rotation-data-source';
import { RotationTransformService } from '../app/pages/post-raid/rotation/rotation-transform.service';
import { DEFENSIVE_DATA_SOURCE } from '../app/pages/post-raid/defensive/defensive-data-source';
import { DefensiveTransformService } from '../app/pages/post-raid/defensive/defensive-transform.service';
import { GEAR_DATA_SOURCE } from '../app/pages/post-raid/gear/gear-data-source';
import { GearTransformService } from '../app/pages/post-raid/gear/gear-transform.service';
import { MAP_DATA_SOURCE } from '../app/pages/post-raid/map/map-data-source';
import { MapTransformService } from '../app/pages/post-raid/map/map-transform.service';
import { NORTHERN_SKY_DATA_SOURCE } from '../app/pages/post-raid/northern-sky/northern-sky-data-source';
import { NorthernSkyTransformService } from '../app/pages/post-raid/northern-sky/northern-sky-transform.service';

export const liveDataSourceProviders: Provider[] = [
  provideLiveDataSource(BURST_DATA_SOURCE, BurstTransformService),
  provideLiveDataSource(ROTATION_DATA_SOURCE, RotationTransformService),
  provideLiveDataSource(DEFENSIVE_DATA_SOURCE, DefensiveTransformService),
  provideLiveDataSource(GEAR_DATA_SOURCE, GearTransformService),
  provideLiveDataSource(MAP_DATA_SOURCE, MapTransformService),
  provideLiveDataSource(NORTHERN_SKY_DATA_SOURCE, NorthernSkyTransformService),
];
