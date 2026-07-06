import { describe, it, expect } from 'vitest';
import { InjectionToken, Injector } from '@angular/core';
import { DataSource } from './data-source';
import { EmptyDataSource } from './empty-data-source';
import { provideEmptyDataSource } from './provide-data-source';
import { missing } from '../result';

describe('EmptyDataSource', () => {
  it('always resolves missing (a fresh, un-ingested tier)', async () => {
    const source = new EmptyDataSource<{ x: number }>();
    expect(await source.getBench()).toEqual(missing('Not yet ingested.'));
  });
});

describe('provideEmptyDataSource', () => {
  it('binds the token to an EmptyDataSource', () => {
    const token = new InjectionToken<DataSource<unknown>>('TEST');
    const injector = Injector.create({ providers: [provideEmptyDataSource(token)] });
    expect(injector.get(token)).toBeInstanceOf(EmptyDataSource);
  });
});
