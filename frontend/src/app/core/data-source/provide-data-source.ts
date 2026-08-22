import { InjectionToken, Provider, Type, inject } from '@angular/core';
import { DataFileApiService } from '../services/data-file-api';
import { DataSource } from './data-source';
import { FileDataSource } from './file-data-source';

// A typo in this union would silently bind a token to a directory that 404s to a `missing` result, masking a misconfiguration as un-ingested data.
export type SliceDir = 'burst' | 'rotation' | 'defensive' | 'gear' | 'positions' | 'northern-sky';

// Used from `environment.ts` only, so a production build never references a `*TransformService`.
export function provideFileDataSource<T>(token: InjectionToken<DataSource<T>>, slice: SliceDir): Provider {
  return { provide: token, useFactory: () => new FileDataSource<T>(inject(DataFileApiService), slice) };
}

// Importing the transforms here (and nowhere in the eager production graph) is what lets a production build tree-shake them out entirely.
export function provideLiveDataSource<T>(token: InjectionToken<DataSource<T>>, liveImpl: Type<DataSource<T>>): Provider {
  return { provide: token, useExisting: liveImpl };
}

