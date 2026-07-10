/**
 * Ingest environment (swapped in by the `ingest` build configuration; run via
 * `npm run start:ingest`, which also starts the local file server on :3000). Progress
 * logs to the browser console. Run `npm run data:pull` first so the signature-skip
 * check has the current published data to compare against.
 *
 * `wclClientId`/`wclClientSecret` default to the intentionally public pair every build
 * ships (see wcl-public-client.ts). To ingest on a dedicated WCL client's budget, edit
 * them here locally (do not commit a private pair).
 */
import { EnvironmentProviders, Provider, inject, provideAppInitializer } from '@angular/core';
import { WCL_PUBLIC_CLIENT_ID, WCL_PUBLIC_CLIENT_SECRET } from './wcl-public-client';
import { provideLiveDataSource } from '../app/core/data-source/provide-data-source';
import { DATA_FILE_TRANSPORT } from '../app/core/services/data-file-transport';
import { RETRY_MAX_ATTEMPTS } from '../app/core/interceptors/retry-transient.interceptor';
import { IngestHttpDataFileTransport } from '../app/ingest/ingest-data-file-transport';
import { IngestOrchestratorService } from '../app/ingest/ingest-orchestrator.service';
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

// Why 3: see RETRY_MAX_ATTEMPTS - unattended runs must ride out longer blips.
const INGEST_RETRY_MAX_ATTEMPTS = 3;

export const environment = {
  useLiveTransform: true,
  /** Unused in ingest mode: every data-file read goes through the file server. */
  dataBaseHref: '',
  ingest: true,
  /** Set locally to target a single spec folder (e.g. 'SubtletyRogue') instead of all. */
  ingestSpec: null as string | null,
  wclClientId: WCL_PUBLIC_CLIENT_ID,
  wclClientSecret: WCL_PUBLIC_CLIENT_SECRET,
};

export const environmentProviders: (Provider | EnvironmentProviders)[] = [
  provideLiveDataSource(BURST_DATA_SOURCE, BurstTransformService),
  provideLiveDataSource(ROTATION_DATA_SOURCE, RotationTransformService),
  provideLiveDataSource(DEFENSIVE_DATA_SOURCE, DefensiveTransformService),
  provideLiveDataSource(GEAR_DATA_SOURCE, GearTransformService),
  provideLiveDataSource(MAP_DATA_SOURCE, MapTransformService),
  { provide: DATA_FILE_TRANSPORT, useExisting: IngestHttpDataFileTransport },
  { provide: RETRY_MAX_ATTEMPTS, useValue: INGEST_RETRY_MAX_ATTEMPTS },
  provideAppInitializer(() => {
    // Not awaited: the app shell must render while ingestion runs; run() owns its failures.
    void inject(IngestOrchestratorService).run();
  }),
];
