import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { whenStable } from '../../testing/when-stable';
import { LatestLoad } from './latest-load';

const FIRST_VALUE = 'first response';
const SECOND_VALUE = 'second response';
const LOAD_CONTEXT = 'feature.loadView';
const LOAD_FAILURE = new Error('bench data unavailable');

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

/** A manually-controlled promise so tests decide exactly when each load settles. */
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Awaits one microtask tick per then -> catch -> finally stage so every callback has fired before asserting. */
async function flushLoadChain(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

/** LatestLoad reports its chain to PendingTasks, so it only constructs inside an injection context. */
function newLoader(): LatestLoad {
  TestBed.resetTestingModule();
  return TestBed.runInInjectionContext(() => new LatestLoad());
}

function spyOnConsoleWarn() {
  return vi.spyOn(console, 'warn').mockImplementation(() => undefined);
}

describe('LatestLoad', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('applies the value of the latest load', async () => {
    const loader = newLoader();
    const load = deferred<string>();
    const applied: string[] = [];

    loader.run(load.promise, { context: LOAD_CONTEXT, apply: value => applied.push(value) });
    load.resolve(FIRST_VALUE);
    await flushLoadChain();

    expect(applied).toEqual([FIRST_VALUE]);
  });

  it('ignores a stale response that resolves after a newer run started', async () => {
    const loader = newLoader();
    const staleLoad = deferred<string>();
    const latestLoad = deferred<string>();
    const applied: string[] = [];

    loader.run(staleLoad.promise, { context: LOAD_CONTEXT, apply: value => applied.push(value) });
    loader.run(latestLoad.promise, { context: LOAD_CONTEXT, apply: value => applied.push(value) });
    staleLoad.resolve(FIRST_VALUE);
    await flushLoadChain();

    expect(applied).toEqual([]);

    latestLoad.resolve(SECOND_VALUE);
    await flushLoadChain();

    expect(applied).toEqual([SECOND_VALUE]);
  });

  it('logs a warning with the load context and applies nothing when the load rejects', async () => {
    const warnSpy = spyOnConsoleWarn();
    const loader = newLoader();
    const load = deferred<string>();
    const applied: string[] = [];

    loader.run(load.promise, { context: LOAD_CONTEXT, apply: value => applied.push(value) });
    load.reject(LOAD_FAILURE);
    await flushLoadChain();

    expect(applied).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(LOAD_CONTEXT), LOAD_FAILURE);
  });

  it('fires settled for the latest load when it resolves', async () => {
    const loader = newLoader();
    const load = deferred<string>();
    let settledCount = 0;

    loader.run(load.promise, {
      context: LOAD_CONTEXT,
      apply: () => undefined,
      settled: () => { settledCount++; },
    });
    load.resolve(FIRST_VALUE);
    await flushLoadChain();

    expect(settledCount).toBe(1);
  });

  it('fires settled for the latest load when it rejects', async () => {
    spyOnConsoleWarn();
    const loader = newLoader();
    const load = deferred<string>();
    let settledCount = 0;

    loader.run(load.promise, {
      context: LOAD_CONTEXT,
      apply: () => undefined,
      settled: () => { settledCount++; },
    });
    load.reject(LOAD_FAILURE);
    await flushLoadChain();

    expect(settledCount).toBe(1);
  });

  it('does not fire settled for a stale load but fires it for the newer one', async () => {
    const loader = newLoader();
    const staleLoad = deferred<string>();
    const latestLoad = deferred<string>();
    let staleSettledCount = 0;
    let latestSettledCount = 0;

    loader.run(staleLoad.promise, {
      context: LOAD_CONTEXT,
      apply: () => undefined,
      settled: () => { staleSettledCount++; },
    });
    loader.run(latestLoad.promise, {
      context: LOAD_CONTEXT,
      apply: () => undefined,
      settled: () => { latestSettledCount++; },
    });
    staleLoad.resolve(FIRST_VALUE);
    latestLoad.resolve(SECOND_VALUE);
    await flushLoadChain();

    expect(staleSettledCount).toBe(0);
    expect(latestSettledCount).toBe(1);
  });

  it('logs the warning for a stale rejection but fires no settled', async () => {
    const warnSpy = spyOnConsoleWarn();
    const loader = newLoader();
    const staleLoad = deferred<string>();
    const latestLoad = deferred<string>();
    let staleSettledCount = 0;

    loader.run(staleLoad.promise, {
      context: LOAD_CONTEXT,
      apply: () => undefined,
      settled: () => { staleSettledCount++; },
    });
    loader.run(latestLoad.promise, { context: LOAD_CONTEXT, apply: () => undefined });
    staleLoad.reject(LOAD_FAILURE);
    await flushLoadChain();

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(LOAD_CONTEXT), LOAD_FAILURE);
    expect(staleSettledCount).toBe(0);
  });

  // A bare stability check only spans a few microtask turns, so this depth is what proves the reported task is doing the waiting.
  const DEEPER_THAN_A_BARE_STABILITY_CHECK = 20;

  it('holds the app unstable until the chain settles, however many turns the load takes', async () => {
    const loader = newLoader();
    let applied = '';
    let load = Promise.resolve(FIRST_VALUE);
    for (let hop = 0; hop < DEEPER_THAN_A_BARE_STABILITY_CHECK; hop++) load = load.then(value => value);

    loader.run(load, { context: LOAD_CONTEXT, apply: value => { applied = value; } });
    await whenStable();

    expect(applied).toBe(FIRST_VALUE);
  });

  it('lets the app settle once the load has, so a later wait does not hang', async () => {
    const loader = newLoader();
    const load = deferred<string>();

    loader.run(load.promise, { context: LOAD_CONTEXT, apply: () => undefined });
    load.resolve(FIRST_VALUE);
    await whenStable();

    await expect(whenStable()).resolves.toBeUndefined();
  });
});
