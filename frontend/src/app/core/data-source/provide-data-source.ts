import { InjectionToken, Provider, Type, inject } from '@angular/core';
import { DataFileApiService } from '../services/data-file-api';
import { DataSource } from './data-source';
import { FileDataSource } from './file-data-source';

/**
 * The on-disk data directory a slice reads under `data/specs/{spec}/`. Naming one of
 * these literals is the only thing that varies across slices at the binding call site, so
 * the union keeps a typo from silently binding a token to a directory that does not exist
 * (which would read `null` and render an empty card with no error).
 */
export type SliceDir = 'burst' | 'rotation' | 'defensive' | 'gear' | 'positions';

/**
 * Production binding for a per-use-case `*_DATA_SOURCE` token: a `FileDataSource<T>` that
 * reads the ingest-baked tailored file `data/specs/{spec}/{slice}/{enc}.json` through the
 * pass-through `DataFileApiService`. Used from `environment.ts` only, so a production build
 * never references a `*TransformService`.
 */
export function provideFileDataSource<T>(token: InjectionToken<DataSource<T>>, slice: SliceDir): Provider {
  return { provide: token, useFactory: () => new FileDataSource<T>(inject(DataFileApiService), slice) };
}

/**
 * Development binding for a `*_DATA_SOURCE` token: the slice's own `*TransformService`,
 * which computes the prepared data live from WCL (no ingestion). Used from
 * `environment.development.ts` only - importing the transforms there (and nowhere in the
 * eager production graph) is what lets a production build tree-shake them out entirely.
 * The transform is `providedIn: 'root'`, so `useExisting` reuses the singleton.
 */
export function provideLiveDataSource<T>(token: InjectionToken<DataSource<T>>, liveImpl: Type<DataSource<T>>): Provider {
  return { provide: token, useExisting: liveImpl };
}
