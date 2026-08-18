import { assert, afterEach, describe, expect, it, vi } from 'vitest';
import { OutputEmitterRef, WritableSignal, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Result, missing, ok, permanent, transient } from '../core/result';
import { whenStable } from '../../testing/when-stable';
import { LoadResource, loadResource } from './load-resource';

const LOAD_CONTEXT = 'feature.loadView';
const FIRST_PARAMS = 'first-selection';
const SECOND_PARAMS = 'second-selection';
const FIRST_VALUE = 'first view';
const SECOND_VALUE = 'second view';
const EMPTY_VALUE = '';
const OUTAGE_MESSAGE = 'WCL is unreachable right now.';
const NOT_INGESTED_MESSAGE = 'This encounter is not ingested yet.';
const UNUSABLE_MESSAGE = 'The bench is unusable.';
const UNUSABLE_ID = 'feature.bench-unusable';
const UNUSABLE_CONTEXT = { rows: 0 };
const LOAD_FAILURE = new Error('the transport threw');

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface HarnessOptions {
  availableWhen?: (value: string) => boolean;
  initialAvailable?: boolean;
  withAvailableChange?: boolean;
}

interface Harness {
  card: LoadResource<string>;
  params: WritableSignal<string>;
  busy: boolean[];
  availability: boolean[];
  started: string[];
  settle: (params: string, result: Result<string>) => void;
  fail: (params: string, cause: unknown) => void;
  start: () => void;
}

function harness(options: HarnessOptions = {}): Harness {
  TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
  const params = signal(FIRST_PARAMS);
  const started: string[] = [];
  const pending = new Map<string, Deferred<Result<string>>>();
  const busy: boolean[] = [];
  const availability: boolean[] = [];

  const card = TestBed.runInInjectionContext(() => {
    const busyChange = new OutputEmitterRef<boolean>();
    const availableChange = new OutputEmitterRef<boolean>();
    busyChange.subscribe(value => busy.push(value));
    availableChange.subscribe(value => availability.push(value));
    return loadResource<string, string>({
      params,
      load: selection => {
        started.push(selection);
        const load = deferred<Result<string>>();
        pending.set(selection, load);
        return load.promise;
      },
      context: LOAD_CONTEXT,
      availableWhen: options.availableWhen,
      initialAvailable: options.initialAvailable,
      busyChange,
      availableChange: options.withAvailableChange === false ? undefined : availableChange,
    });
  });

  function take(selection: string): Deferred<Result<string>> {
    const load = pending.get(selection);
    assert.exists(load);
    return load;
  }

  return {
    card, params, busy, availability, started,
    settle: (selection, result) => { take(selection).resolve(result); },
    fail: (selection, cause) => { take(selection).reject(cause); },
    start: () => { TestBed.tick(); },
  };
}

// A settled load runs through the loader body, the resource, and the linked signal; fewer turns than this reads state mid-flight.
const TURNS_TO_APPLY_A_SETTLED_LOAD = 5;

/** `whenStable` would block on loads still in flight; this advances past settled ones only. */
async function drain(): Promise<void> {
  for (let turn = 0; turn < TURNS_TO_APPLY_A_SETTLED_LOAD; turn++) await Promise.resolve();
  TestBed.tick();
}

function spyOnConsoleWarn() {
  return vi.spyOn(console, 'warn').mockImplementation(() => undefined);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('loadResource content state', () => {
  it('exposes the loaded value once the load lands ok', async () => {
    const h = harness();
    h.start();
    h.settle(FIRST_PARAMS, ok(FIRST_VALUE));
    await whenStable();

    expect(h.card.value()).toBe(FIRST_VALUE);
  });

  it('reports the card available, with no error, for an ok result', async () => {
    const h = harness();
    h.start();
    h.settle(FIRST_PARAMS, ok(FIRST_VALUE));
    await whenStable();

    expect(h.card.available()).toBe(true);
    expect(h.card.error()).toBeNull();
  });

  it('reloads and applies the new value when the params change', async () => {
    const h = harness();
    h.start();
    h.settle(FIRST_PARAMS, ok(FIRST_VALUE));
    await whenStable();

    h.params.set(SECOND_PARAMS);
    h.start();
    h.settle(SECOND_PARAMS, ok(SECOND_VALUE));
    await whenStable();

    expect(h.started).toEqual([FIRST_PARAMS, SECOND_PARAMS]);
    expect(h.card.value()).toBe(SECOND_VALUE);
  });
});

describe('loadResource waiting state', () => {
  it('holds a null value and no error before the first load lands', () => {
    const h = harness();

    expect(h.card.value()).toBeNull();
    expect(h.card.error()).toBeNull();
  });

  it('reads initialAvailable before the first load lands', () => {
    const h = harness({ initialAvailable: true });

    expect(h.card.available()).toBe(true);
  });

  it('reads unavailable before the first load lands when initialAvailable is unset', () => {
    const h = harness();

    expect(h.card.available()).toBe(false);
  });

  it('treats a missing result as waiting rather than as an error', async () => {
    const h = harness({ initialAvailable: true });
    h.start();
    h.settle(FIRST_PARAMS, missing(NOT_INGESTED_MESSAGE));
    await whenStable();

    expect(h.card.error()).toBeNull();
    expect(h.card.value()).toBeNull();
    expect(h.card.available()).toBe(false);
  });
});

describe('loadResource error states', () => {
  it('renders a transient error and drops the value', async () => {
    const h = harness();
    h.start();
    h.settle(FIRST_PARAMS, transient(OUTAGE_MESSAGE));
    await whenStable();

    expect(h.card.error()).toEqual({ kind: 'transient', message: OUTAGE_MESSAGE });
    expect(h.card.value()).toBeNull();
    expect(h.card.available()).toBe(false);
  });

  it('does not log a transient error, which the interceptor already retried', async () => {
    const warnSpy = spyOnConsoleWarn();
    const h = harness();
    h.start();
    h.settle(FIRST_PARAMS, transient(OUTAGE_MESSAGE));
    await whenStable();

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('renders a permanent error and drops the value', async () => {
    spyOnConsoleWarn();
    const h = harness();
    h.start();
    h.settle(FIRST_PARAMS, permanent(UNUSABLE_MESSAGE, UNUSABLE_ID, UNUSABLE_CONTEXT));
    await whenStable();

    expect(h.card.error()).toEqual({ kind: 'permanent', message: UNUSABLE_MESSAGE, id: UNUSABLE_ID, context: UNUSABLE_CONTEXT });
    expect(h.card.value()).toBeNull();
    expect(h.card.available()).toBe(false);
  });

  it('logs a permanent error under its own id, not the load context', async () => {
    const warnSpy = spyOnConsoleWarn();
    const h = harness();
    h.start();
    h.settle(FIRST_PARAMS, permanent(UNUSABLE_MESSAGE, UNUSABLE_ID, UNUSABLE_CONTEXT));
    await whenStable();

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(UNUSABLE_ID), UNUSABLE_CONTEXT);
  });

  it('clears the error when a later load lands ok', async () => {
    const h = harness();
    h.start();
    h.settle(FIRST_PARAMS, transient(OUTAGE_MESSAGE));
    await whenStable();

    h.params.set(SECOND_PARAMS);
    h.start();
    h.settle(SECOND_PARAMS, ok(SECOND_VALUE));
    await whenStable();

    expect(h.card.error()).toBeNull();
    expect(h.card.value()).toBe(SECOND_VALUE);
    expect(h.card.available()).toBe(true);
  });
});

describe('loadResource availableWhen', () => {
  const hasContent = (value: string): boolean => value.length > 0;

  it('reports unavailable when availableWhen rejects the loaded value', async () => {
    const h = harness({ availableWhen: hasContent });
    h.start();
    h.settle(FIRST_PARAMS, ok(EMPTY_VALUE));
    await whenStable();

    expect(h.card.available()).toBe(false);
    expect(h.card.error()).toBeNull();
  });

  it('reports available when availableWhen accepts the loaded value', async () => {
    const h = harness({ availableWhen: hasContent });
    h.start();
    h.settle(FIRST_PARAMS, ok(FIRST_VALUE));
    await whenStable();

    expect(h.card.available()).toBe(true);
  });

  it('still exposes the value of a loaded-but-unavailable result', async () => {
    const h = harness({ availableWhen: hasContent });
    h.start();
    h.settle(FIRST_PARAMS, ok(EMPTY_VALUE));
    await whenStable();

    expect(h.card.value()).toBe(EMPTY_VALUE);
  });

  it('never consults availableWhen for a failed result', async () => {
    const availableWhen = vi.fn(() => true);
    const h = harness({ availableWhen, initialAvailable: true });
    h.start();
    h.settle(FIRST_PARAMS, transient(OUTAGE_MESSAGE));
    await whenStable();

    expect(availableWhen).not.toHaveBeenCalled();
    expect(h.card.available()).toBe(false);
  });
});

describe('loadResource busyChange', () => {
  it('emits busy false exactly once when a load lands ok, and never emits busy true', async () => {
    const h = harness();
    h.start();
    h.settle(FIRST_PARAMS, ok(FIRST_VALUE));
    await whenStable();

    expect(h.busy).toEqual([false]);
  });

  it('emits busy false when the load lands a failed result', async () => {
    const h = harness();
    h.start();
    h.settle(FIRST_PARAMS, transient(OUTAGE_MESSAGE));
    await whenStable();

    expect(h.busy).toEqual([false]);
  });

  it('emits busy false again for each reload', async () => {
    const h = harness();
    h.start();
    h.settle(FIRST_PARAMS, ok(FIRST_VALUE));
    await whenStable();

    h.params.set(SECOND_PARAMS);
    h.start();
    h.settle(SECOND_PARAMS, ok(SECOND_VALUE));
    await whenStable();

    expect(h.busy).toEqual([false, false]);
  });

  it('emits busy false only after the load settles, not when it starts', () => {
    const h = harness();
    h.start();

    expect(h.started).toEqual([FIRST_PARAMS]);
    expect(h.busy).toEqual([]);
  });
});

describe('loadResource availableChange', () => {
  it('emits available true when an ok result lands', async () => {
    const h = harness();
    h.start();
    h.settle(FIRST_PARAMS, ok(FIRST_VALUE));
    await whenStable();

    expect(h.availability).toEqual([true]);
  });

  it('emits available false when the load fails', async () => {
    const h = harness();
    h.start();
    h.settle(FIRST_PARAMS, transient(OUTAGE_MESSAGE));
    await whenStable();

    expect(h.availability).toEqual([false]);
  });

  it('emits the availableWhen verdict for an ok result', async () => {
    const h = harness({ availableWhen: value => value.length > 0 });
    h.start();
    h.settle(FIRST_PARAMS, ok(EMPTY_VALUE));
    await whenStable();

    expect(h.availability).toEqual([false]);
  });

  it('settles a load with no availableChange wired', async () => {
    const h = harness({ withAvailableChange: false });
    h.start();
    h.settle(FIRST_PARAMS, ok(FIRST_VALUE));
    await whenStable();

    expect(h.card.value()).toBe(FIRST_VALUE);
    expect(h.busy).toEqual([false]);
    expect(h.availability).toEqual([]);
  });
});

describe('loadResource latest-wins', () => {
  it('neither writes nor emits for a load superseded before it settles', async () => {
    const h = harness();
    h.start();
    h.params.set(SECOND_PARAMS);
    h.start();

    h.settle(FIRST_PARAMS, ok(FIRST_VALUE));
    await drain();

    expect(h.card.value()).toBeNull();
    expect(h.busy).toEqual([]);
    expect(h.availability).toEqual([]);
  });

  it('applies the winning load after the superseded one already settled', async () => {
    const h = harness();
    h.start();
    h.params.set(SECOND_PARAMS);
    h.start();

    h.settle(FIRST_PARAMS, ok(FIRST_VALUE));
    await drain();
    h.settle(SECOND_PARAMS, ok(SECOND_VALUE));
    await whenStable();

    expect(h.card.value()).toBe(SECOND_VALUE);
    expect(h.busy).toEqual([false]);
    expect(h.availability).toEqual([true]);
  });

  it('keeps the winner\'s error out of reach of a superseded failed result', async () => {
    const h = harness();
    h.start();
    h.params.set(SECOND_PARAMS);
    h.start();

    h.settle(FIRST_PARAMS, transient(OUTAGE_MESSAGE));
    await drain();
    h.settle(SECOND_PARAMS, ok(SECOND_VALUE));
    await whenStable();

    expect(h.card.error()).toBeNull();
    expect(h.card.value()).toBe(SECOND_VALUE);
  });

  it('emits no busy for a superseded load that rejects, though it still logs', async () => {
    const warnSpy = spyOnConsoleWarn();
    const h = harness();
    h.start();
    h.params.set(SECOND_PARAMS);
    h.start();

    h.fail(FIRST_PARAMS, LOAD_FAILURE);
    await drain();
    h.settle(SECOND_PARAMS, ok(SECOND_VALUE));
    await whenStable();

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(LOAD_CONTEXT), LOAD_FAILURE);
    expect(h.busy).toEqual([false]);
    expect(h.card.value()).toBe(SECOND_VALUE);
  });
});

describe('loadResource rejected load', () => {
  it('logs the rejection under the load context and emits busy false', async () => {
    const warnSpy = spyOnConsoleWarn();
    const h = harness();
    h.start();
    h.fail(FIRST_PARAMS, LOAD_FAILURE);
    await whenStable();

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(LOAD_CONTEXT), LOAD_FAILURE);
    expect(h.busy).toEqual([false]);
  });

  it('emits no availableChange for a rejected load, which states nothing about the bench', async () => {
    spyOnConsoleWarn();
    const h = harness();
    h.start();
    h.fail(FIRST_PARAMS, LOAD_FAILURE);
    await whenStable();

    expect(h.availability).toEqual([]);
  });

  it('leaves the card state untouched when a reload rejects', async () => {
    spyOnConsoleWarn();
    const h = harness();
    h.start();
    h.settle(FIRST_PARAMS, ok(FIRST_VALUE));
    await whenStable();
    expect(h.card.value()).toBe(FIRST_VALUE);

    h.params.set(SECOND_PARAMS);
    h.start();
    h.fail(SECOND_PARAMS, LOAD_FAILURE);
    await whenStable();

    expect(h.card.value()).toBe(FIRST_VALUE);
    expect(h.card.available()).toBe(true);
    expect(h.card.error()).toBeNull();
  });

  it('raises no error state from a rejected first load, leaving the card waiting', async () => {
    spyOnConsoleWarn();
    const h = harness();
    h.start();
    h.fail(FIRST_PARAMS, LOAD_FAILURE);
    await whenStable();

    expect(h.card.error()).toBeNull();
    expect(h.card.value()).toBeNull();
  });
});

// Retention is lazy: each case must read the rendered state before reloading, or linkedSignal has nothing to retain.
describe('loadResource reload retention', () => {
  it('keeps the last value while a reload is in flight', async () => {
    const h = harness();
    h.start();
    h.settle(FIRST_PARAMS, ok(FIRST_VALUE));
    await whenStable();
    expect(h.card.value()).toBe(FIRST_VALUE);

    h.params.set(SECOND_PARAMS);
    h.start();

    expect(h.started).toEqual([FIRST_PARAMS, SECOND_PARAMS]);
    expect(h.card.value()).toBe(FIRST_VALUE);
    expect(h.card.available()).toBe(true);
  });

  it('replaces the retained value once the reload lands', async () => {
    const h = harness();
    h.start();
    h.settle(FIRST_PARAMS, ok(FIRST_VALUE));
    await whenStable();
    expect(h.card.value()).toBe(FIRST_VALUE);

    h.params.set(SECOND_PARAMS);
    h.start();
    h.settle(SECOND_PARAMS, ok(SECOND_VALUE));
    await whenStable();

    expect(h.card.value()).toBe(SECOND_VALUE);
  });

  it('keeps the last error while a reload is in flight', async () => {
    const h = harness();
    h.start();
    h.settle(FIRST_PARAMS, transient(OUTAGE_MESSAGE));
    await whenStable();
    expect(h.card.error()).toEqual({ kind: 'transient', message: OUTAGE_MESSAGE });

    h.params.set(SECOND_PARAMS);
    h.start();

    expect(h.card.error()).toEqual({ kind: 'transient', message: OUTAGE_MESSAGE });
  });
});
