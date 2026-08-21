import { afterEach, describe, expect, it, vi } from 'vitest';
import { missing, ok, permanent, transient } from '../../core/result';
import { whenStable } from '../../../testing/when-stable';
import {
  EMPTY_VALUE, FIRST_PARAMS, FIRST_VALUE, OUTAGE_MESSAGE, SECOND_PARAMS, SECOND_VALUE, harness, spyOnConsoleWarn,
} from './load-resource-harness';

const NOT_INGESTED_MESSAGE = 'This encounter is not ingested yet.';
const UNUSABLE_MESSAGE = 'The bench is unusable.';
const UNUSABLE_ID = 'feature.bench-unusable';
const UNUSABLE_CONTEXT = { rows: 0 };

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
