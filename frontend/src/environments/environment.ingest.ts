/** Run `npm run data:pull` first: the signature-skip check compares against the published data. */
import { EnvironmentProviders, Provider, inject, provideAppInitializer } from '@angular/core';
import { withEnvironment } from './base-environment';
import { liveDataSourceProviders } from './live-data-sources';
import { DATA_FILE_TRANSPORT } from '../app/core/services/data-file-transport';
import { RETRY_MAX_ATTEMPTS } from '../app/core/transport/retry-transient.interceptor';
import { IngestHttpDataFileTransport } from '../app/ingest/transport/ingest-data-file-transport';
import { IngestOrchestratorService } from '../app/ingest/shell/ingest-orchestrator.service';

// Why 3: see RETRY_MAX_ATTEMPTS - unattended runs must ride out longer blips.
const INGEST_RETRY_MAX_ATTEMPTS = 3;

export const environment = withEnvironment({ ingest: true });

export const environmentProviders: (Provider | EnvironmentProviders)[] = [
  ...liveDataSourceProviders,
  { provide: DATA_FILE_TRANSPORT, useExisting: IngestHttpDataFileTransport },
  { provide: RETRY_MAX_ATTEMPTS, useValue: INGEST_RETRY_MAX_ATTEMPTS },
  provideAppInitializer(() => {
    // Not awaited: the app shell must render while ingestion runs; run() owns its failures.
    void inject(IngestOrchestratorService).run();
  }),
];
