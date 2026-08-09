/** Production environment: binds every `*_DATA_SOURCE` token to a generic `FileDataSource` that reads the ingested, tailored static file. */
import { Provider } from '@angular/core';
import { WCL_PUBLIC_CLIENT_ID, WCL_PUBLIC_CLIENT_SECRET } from './wcl-public-client';
import { provideFileDataSource } from '../app/core/data-source/provide-data-source';
import { BURST_DATA_SOURCE } from '../app/pages/post-raid/burst-windows/burst-data-source';
import { ROTATION_DATA_SOURCE } from '../app/pages/post-raid/rotation/rotation-data-source';
import { DEFENSIVE_DATA_SOURCE } from '../app/pages/post-raid/defensive/defensive-data-source';
import { GEAR_DATA_SOURCE } from '../app/pages/post-raid/gear/gear-data-source';
import { MAP_DATA_SOURCE } from '../app/pages/post-raid/map/map-data-source';
import { NORTHERN_SKY_DATA_SOURCE } from '../app/pages/post-raid/northern-sky/northern-sky-data-source';

export const environment = {
  /** Absolute base for the static data files; must stay a sibling of every environment folder (`main/`, `pr-N/`), which `.github/workflows/deploy-pages.yml` derives each build's `--base-href` from. */
  dataBaseHref: '/data/specs/',
  ingest: false,
  /** WCL client-credentials pair (intentionally public - see wcl-public-client.ts). */
  wclClientId: WCL_PUBLIC_CLIENT_ID,
  wclClientSecret: WCL_PUBLIC_CLIENT_SECRET,
};

/** This file imports only the slice tokens (never a `*TransformService`), so the five transforms are absent from the eager production graph and tree-shaken from the bundle. */
export const environmentProviders: Provider[] = [
  provideFileDataSource(BURST_DATA_SOURCE, 'burst'),
  provideFileDataSource(ROTATION_DATA_SOURCE, 'rotation'),
  provideFileDataSource(DEFENSIVE_DATA_SOURCE, 'defensive'),
  provideFileDataSource(GEAR_DATA_SOURCE, 'gear'),
  provideFileDataSource(MAP_DATA_SOURCE, 'positions'),
  provideFileDataSource(NORTHERN_SKY_DATA_SOURCE, 'northern-sky'),
];
