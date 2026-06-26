import { InjectionToken, Provider, Type } from '@angular/core';
import { environment } from '../../../environments/environment';

/**
 * Bind a per-use-case `*_DATA_SOURCE` token to one of its two implementations,
 * chosen by the build-time dev flag:
 *
 * - production (`useLiveTransform: false`) -> the `*DataFileService` (reads the
 *   ingested tailored file).
 * - development (`useLiveTransform: true`) -> the `*TransformService` (computes
 *   the prepared data live from WCL, no ingestion needed).
 *
 * Both impls are `providedIn: 'root'`, so `useExisting` reuses the singleton.
 * This factory is the ONLY place the data source is selected.
 */
export function provideDataSource<T>(
  token: InjectionToken<T>,
  fileImpl: Type<T>,
  liveImpl: Type<T>,
): Provider {
  return { provide: token, useExisting: environment.useLiveTransform ? liveImpl : fileImpl };
}
