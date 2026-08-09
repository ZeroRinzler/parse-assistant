/** Empty-encounter environment: binds every `*_DATA_SOURCE` to an `EmptyDataSource` (`getBench` always `null`), reproducing a fresh tier with no ingested bench. */
import { Provider } from '@angular/core';
import { WCL_PUBLIC_CLIENT_ID, WCL_PUBLIC_CLIENT_SECRET } from './wcl-public-client';
import { provideEmptyDataSource } from '../app/core/data-source/provide-data-source';
import { BURST_DATA_SOURCE } from '../app/pages/post-raid/burst-windows/burst-data-source';
import { ROTATION_DATA_SOURCE } from '../app/pages/post-raid/rotation/rotation-data-source';
import { DEFENSIVE_DATA_SOURCE } from '../app/pages/post-raid/defensive/defensive-data-source';
import { GEAR_DATA_SOURCE } from '../app/pages/post-raid/gear/gear-data-source';
import { MAP_DATA_SOURCE } from '../app/pages/post-raid/map/map-data-source';
import { NORTHERN_SKY_DATA_SOURCE } from '../app/pages/post-raid/northern-sky/northern-sky-data-source';

export const environment = {
  /** Empty resolves `data/specs/` relative to `document.baseURI` (the `data:pull`ed `public/data/specs/`), so manifests + rulebooks load while the benches stay empty. */
  dataBaseHref: '',
  ingest: false,
  /** WCL client-credentials pair (intentionally public - see wcl-public-client.ts). */
  wclClientId: WCL_PUBLIC_CLIENT_ID,
  wclClientSecret: WCL_PUBLIC_CLIENT_SECRET,
};

export const environmentProviders: Provider[] = [
  provideEmptyDataSource(BURST_DATA_SOURCE),
  provideEmptyDataSource(ROTATION_DATA_SOURCE),
  provideEmptyDataSource(DEFENSIVE_DATA_SOURCE),
  provideEmptyDataSource(GEAR_DATA_SOURCE),
  provideEmptyDataSource(MAP_DATA_SOURCE),
  provideEmptyDataSource(NORTHERN_SKY_DATA_SOURCE),
];
