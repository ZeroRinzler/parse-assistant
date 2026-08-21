import { afterEach, describe, expect, it, vi } from 'vitest';
import { ok, transient } from '../../core/result';
import { whenStable } from '../../../testing/when-stable';
import {
  FIRST_PARAMS, FIRST_VALUE, LOAD_CONTEXT, OUTAGE_MESSAGE, SECOND_PARAMS, SECOND_VALUE, drain, harness, spyOnConsoleWarn,
} from './load-resource-harness';

const LOAD_FAILURE = new Error('the transport threw');

afterEach(() => {
  vi.restoreAllMocks();
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
