import { describe, expect, it } from 'vitest';
import { ok, transient } from '../../core/result';
import { whenStable } from '../../../testing/when-stable';
import {
  EMPTY_VALUE, FIRST_PARAMS, FIRST_VALUE, OUTAGE_MESSAGE, SECOND_PARAMS, SECOND_VALUE, harness,
} from './load-resource-harness';

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
