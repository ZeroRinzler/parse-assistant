import { afterEach, describe, expect, it, vi } from 'vitest';
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

function spyOnConsoleWarn() {
  return vi.spyOn(console, 'warn').mockImplementation(() => undefined);
}

describe('LatestLoad', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('applies the value of the latest load', async () => {
    const loader = new LatestLoad();
    const load = deferred<string>();
    const applied: string[] = [];

    loader.run(load.promise, { context: LOAD_CONTEXT, apply: value => applied.push(value) });
    load.resolve(FIRST_VALUE);
    await flushLoadChain();

    expect(applied).toEqual([FIRST_VALUE]);
  });

  it('ignores a stale response that resolves after a newer run started', async () => {
    const loader = new LatestLoad();
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
    const loader = new LatestLoad();
    const load = deferred<string>();
    const applied: string[] = [];

    loader.run(load.promise, { context: LOAD_CONTEXT, apply: value => applied.push(value) });
    load.reject(LOAD_FAILURE);
    await flushLoadChain();

    expect(applied).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(LOAD_CONTEXT), LOAD_FAILURE);
  });

  it('fires settled for the latest load when it resolves', async () => {
    const loader = new LatestLoad();
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
    const loader = new LatestLoad();
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
    const loader = new LatestLoad();
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
    const loader = new LatestLoad();
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
});
