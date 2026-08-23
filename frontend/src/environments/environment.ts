import { Provider } from '@angular/core';
import { withEnvironment } from './base-environment';
import { provideFileDataSource } from '../app/core/data-source/provide-data-source';
import { BURST_DATA_SOURCE } from '../app/features/raid-analysis/burst-windows/data-access/burst-data-source';
import { ROTATION_DATA_SOURCE } from '../app/features/raid-analysis/rotation/data-access/rotation-data-source';
import { DEFENSIVE_DATA_SOURCE } from '../app/features/raid-analysis/defensive/data-access/defensive-data-source';
import { GEAR_DATA_SOURCE } from '../app/features/raid-analysis/gear/data-access/gear-data-source';
import { MAP_DATA_SOURCE } from '../app/features/raid-analysis/map/data-access/map-data-source';
import { NORTHERN_SKY_DATA_SOURCE } from '../app/features/raid-analysis/northern-sky/data-access/northern-sky-data-source';

/** `dataBaseHref` must stay a sibling of every environment folder (`main/`, `pr-N/`), which `.github/workflows/deploy-pages.yml` derives each build's `--base-href` from. */
export const environment = withEnvironment({ dataBaseHref: '/data/specs/' });

/** Never import a `*TransformService` here or it joins the eager production bundle. */
export const environmentProviders: Provider[] = [
  provideFileDataSource(BURST_DATA_SOURCE, 'burst'),
  provideFileDataSource(ROTATION_DATA_SOURCE, 'rotation'),
  provideFileDataSource(DEFENSIVE_DATA_SOURCE, 'defensive'),
  provideFileDataSource(GEAR_DATA_SOURCE, 'gear'),
  provideFileDataSource(MAP_DATA_SOURCE, 'positions'),
  provideFileDataSource(NORTHERN_SKY_DATA_SOURCE, 'northern-sky'),
];
