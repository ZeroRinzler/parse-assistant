/**
 * Empty-encounter environment (swapped in by the `empty` build config; serve via
 * `npm run start:empty`). Binds every `*_DATA_SOURCE` to an `EmptyDataSource` (`getBench`
 * always `null`), reproducing a fresh tier with no ingested bench: every card shows its
 * "waiting for top parses" state and the pages show the no-benchmark banner. Importing only
 * the tokens keeps the transforms tree-shaken out, as in production.
 *
 * Reads through `DataFileApiService` (`index.json`, `spec-meta.json`, `encounters.json`,
 * `rulebook.json`) are untouched, so the dropdowns populate and the rulebook rules evaluate.
 * `dataBaseHref` is empty so they resolve against `document.baseURI`; `npm run data:pull` first.
 */
import { Provider } from '@angular/core';
import { WCL_PUBLIC_CLIENT_ID, WCL_PUBLIC_CLIENT_SECRET } from './wcl-public-client';
import { provideEmptyDataSource } from '../app/core/data-source/provide-data-source';
import { BURST_DATA_SOURCE } from '../app/pages/post-raid/burst-windows/burst-data-source';
import { ROTATION_DATA_SOURCE } from '../app/pages/post-raid/rotation/rotation-data-source';
import { DEFENSIVE_DATA_SOURCE } from '../app/pages/post-raid/defensive/defensive-data-source';
import { GEAR_DATA_SOURCE } from '../app/pages/post-raid/gear/gear-data-source';
import { MAP_DATA_SOURCE } from '../app/pages/post-raid/map/map-data-source';

export const environment = {
  useLiveTransform: false,
  /** Empty resolves `data/specs/` relative to `document.baseURI` (the `data:pull`ed
   * `public/data/specs/`), so manifests + rulebooks load while the benches stay empty. */
  dataBaseHref: '',
  ingest: false,
  ingestSpec: null as string | null,
  /** WCL client-credentials pair (intentionally public - see wcl-public-client.ts). */
  wclClientId: WCL_PUBLIC_CLIENT_ID,
  wclClientSecret: WCL_PUBLIC_CLIENT_SECRET,
};

/** Empty-encounter data-source bindings: every slice reads a null bench. */
export const environmentProviders: Provider[] = [
  provideEmptyDataSource(BURST_DATA_SOURCE),
  provideEmptyDataSource(ROTATION_DATA_SOURCE),
  provideEmptyDataSource(DEFENSIVE_DATA_SOURCE),
  provideEmptyDataSource(GEAR_DATA_SOURCE),
  provideEmptyDataSource(MAP_DATA_SOURCE),
];
