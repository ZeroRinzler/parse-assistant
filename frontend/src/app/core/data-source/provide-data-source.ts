import { InjectionToken, Provider, Type, inject } from '@angular/core';
import { environment } from '../../../environments/environment';
import { DataFileApiService } from '../services/data-file-api';
import { DataSource } from './data-source';
import { FileDataSource } from './file-data-source';

/**
 * The on-disk data directory a slice reads under `data/specs/{spec}/`. Naming one of
 * these literals is the only thing that varies across slices at the `provideDataSource`
 * call site, so the union keeps a typo from silently binding a token to a directory that
 * does not exist (which would read `null` and render an empty card with no error).
 */
export type SliceDir = 'burst' | 'rotation' | 'defensive' | 'gear' | 'positions';

/**
 * Bind a per-use-case `*_DATA_SOURCE` token to one of its two adapters, chosen by the
 * build-time dev flag:
 *
 * - production (`useLiveTransform: false`) -> a `FileDataSource<T>` for `slice` (reads the
 *   ingest-baked tailored file `data/specs/{spec}/{slice}/{enc}.json`).
 * - development (`useLiveTransform: true`) -> the `*TransformService` (computes the prepared
 *   data live from WCL, no ingestion needed); it is `providedIn: 'root'`, so `useExisting`
 *   reuses the singleton.
 *
 * The slice directory name is the only thing that varied across the old five
 * `*DataFileService` classes, so it is a literal argument here - the file half is one
 * generic class, the live half is the slice's own transform. This factory is the ONLY
 * place the data source is selected.
 */
export function provideDataSource<T>(
  token: InjectionToken<DataSource<T>>,
  slice: SliceDir,
  liveImpl: Type<DataSource<T>>,
): Provider {
  return environment.useLiveTransform
    ? { provide: token, useExisting: liveImpl }
    : { provide: token, useFactory: () => new FileDataSource<T>(inject(DataFileApiService), slice) };
}
