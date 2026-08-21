/** A dev run analyzes a fresh log through the transforms instead of reading ingested data files. */
import { Provider } from '@angular/core';
import { withEnvironment } from './base-environment';
import { liveDataSourceProviders } from './live-data-sources';

export const environment = withEnvironment({});

export const environmentProviders: Provider[] = liveDataSourceProviders;
