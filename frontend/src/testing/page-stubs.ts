import { InjectionToken, Provider, signal } from '@angular/core';
import { Result, missing } from '../app/core/result';

/** Callers pass their own `*_DATA_SOURCE` tokens, since only the page layer may name a slice. */
export function stubBenchTokens(
  tokens: readonly InjectionToken<unknown>[],
  bench: Result<never> = missing('Not yet ingested.'),
): Provider[] {
  return tokens.map(token => ({
    provide: token,
    useValue: { getBench: () => Promise.resolve(bench) },
  }));
}

export function mapFeatureStub(overrides: Record<string, unknown> = {}): unknown {
  return {
    clear: () => undefined,
    loadBench: () => Promise.resolve(),
    prepare: () => Promise.resolve(),
    openAt: () => undefined,
    close: () => undefined,
    ready: () => false,
    open: signal(false),
    overlayLoading: signal(false),
    ...overrides,
  };
}
