import { describe, it, expect } from 'vitest';
import {
  orderSpecsByVersion, orderEncountersByMissingFirst, PRIORITY_SPEC, SPEC_LIMIT,
  type SpecOrderEntry,
} from './ordering.ts';

const entry = (over: Partial<SpecOrderEntry> & { spec: string }): SpecOrderEntry => ({
  dataCount: 5,
  onCurrentVersion: true,
  ...over,
});

describe('orderSpecsByVersion', () => {
  it('puts empty specs first, then old-version, then current-version', () => {
    const order = orderSpecsByVersion([
      entry({ spec: 'Current', onCurrentVersion: true }),
      entry({ spec: 'Empty', dataCount: 0, onCurrentVersion: false }),
      entry({ spec: 'Old', onCurrentVersion: false }),
    ]);
    expect(order).toEqual(['Empty', 'Old', 'Current']);
  });

  it('keeps every old-version spec ahead of every current-version spec', () => {
    const order = orderSpecsByVersion([
      entry({ spec: 'CurrentZebra', onCurrentVersion: true }),
      entry({ spec: 'OldApple', onCurrentVersion: false }),
    ]);
    expect(order).toEqual(['OldApple', 'CurrentZebra']);
  });

  it('orders a group by the injected random key (smaller key first)', () => {
    // Keys are drawn per entry in input order; here Charlie < Bravo < Alpha.
    const keys = [0.1, 0.9, 0.5];
    let next = 0;
    const order = orderSpecsByVersion(
      [entry({ spec: 'Charlie' }), entry({ spec: 'Alpha' }), entry({ spec: 'Bravo' })],
      () => keys[next++],
    );
    expect(order).toEqual(['Charlie', 'Bravo', 'Alpha']);
  });

  it('pins the priority spec first within its bracket, ahead of the randomized rest', () => {
    const order = orderSpecsByVersion(
      [
        entry({ spec: 'OutlawRogue' }),
        entry({ spec: PRIORITY_SPEC }),
        entry({ spec: 'AssassinationRogue' }),
      ],
      () => 0,
    );
    expect(order[0]).toBe(PRIORITY_SPEC);
    expect(order.slice(1).sort()).toEqual(['AssassinationRogue', 'OutlawRogue']);
  });

  it('does not pull the priority spec ahead of an earlier (emptier/older-version) bracket', () => {
    const order = orderSpecsByVersion([
      entry({ spec: PRIORITY_SPEC, onCurrentVersion: true }),
      entry({ spec: 'EmptySpec', dataCount: 0, onCurrentVersion: false }),
      entry({ spec: 'OldSpec', onCurrentVersion: false }),
    ]);
    expect(order).toEqual(['EmptySpec', 'OldSpec', PRIORITY_SPEC]);
  });

  it('does not mutate the input', () => {
    const entries = [entry({ spec: 'B' }), entry({ spec: 'A' })];
    const snapshot = entries.map(item => item.spec);
    orderSpecsByVersion(entries);
    expect(entries.map(item => item.spec)).toEqual(snapshot);
  });

  it('returns an empty list for no specs', () => {
    expect(orderSpecsByVersion([])).toEqual([]);
  });

  it('caps a run at ten specs', () => {
    expect(SPEC_LIMIT).toBe(10);
  });
});

describe('orderEncountersByMissingFirst', () => {
  const encounters = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];

  it('moves encounters missing an on-disk slice to the front', () => {
    const present = new Set([2, 4]);
    expect(orderEncountersByMissingFirst(encounters, present).map(item => item.id)).toEqual([
      1, 3, 2, 4,
    ]);
  });

  it('preserves the original order within the missing and present groups (stable)', () => {
    const present = new Set([1]);
    expect(orderEncountersByMissingFirst(encounters, present).map(item => item.id)).toEqual([
      2, 3, 4, 1,
    ]);
  });

  it('keeps the original order when nothing is present yet', () => {
    expect(orderEncountersByMissingFirst(encounters, new Set()).map(item => item.id)).toEqual([
      1, 2, 3, 4,
    ]);
  });

  it('keeps the original order when everything is present', () => {
    const present = new Set([1, 2, 3, 4]);
    expect(orderEncountersByMissingFirst(encounters, present).map(item => item.id)).toEqual([
      1, 2, 3, 4,
    ]);
  });
});
