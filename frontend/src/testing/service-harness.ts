import { InjectionToken, Type } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { DataSource } from '../app/core/data-source/data-source';
import { Result } from '../app/core/result';
import { WclApiService } from '../app/core/services/wcl-api';

export function sliceService<T, S>(
  token: InjectionToken<DataSource<T>>,
  service: Type<S>,
  bench: Result<T>,
  wcl: unknown = {},
): S {
  const source: DataSource<T> = { getBench: () => Promise.resolve(bench) };
  TestBed.configureTestingModule({
    providers: [
      { provide: token, useValue: source },
      { provide: WclApiService, useValue: wcl as WclApiService },
    ],
  });
  return TestBed.inject(service);
}
