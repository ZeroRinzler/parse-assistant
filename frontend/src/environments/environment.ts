import { Provider } from '@angular/core';
import { withEnvironment } from './base-environment';
import { provideFileDataSource } from '../app/core/data-source/provide-data-source';
import { BURST_DATA_SOURCE } from '../app/pages/post-raid/burst-windows/burst-data-source';
import { ROTATION_DATA_SOURCE } from '../app/pages/post-raid/rotation/rotation-data-source';
import { DEFENSIVE_DATA_SOURCE } from '../app/pages/post-raid/defensive/defensive-data-source';
import { GEAR_DATA_SOURCE } from '../app/pages/post-raid/gear/gear-data-source';
import { MAP_DATA_SOURCE } from '../app/pages/post-raid/map/map-data-source';
import { NORTHERN_SKY_DATA_SOURCE } from '../app/pages/post-raid/northern-sky/northern-sky-data-source';

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
