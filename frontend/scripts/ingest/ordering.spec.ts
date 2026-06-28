import { describe, it, expect } from 'vitest';
import {
  orderSpecsByVersionThenTime, orderEncountersByMissingFirst, type SpecOrderEntry,
} from './ordering.ts';

const entry = (over: Partial<SpecOrderEntry> & { spec: string }): SpecOrderEntry => ({
  dataCount: 5,
  onCurrentVersion: true,
  lastChange: 1000,
  ...over,
});

describe('orderSpecsByVersionThenTime', () => {
  it('puts empty specs first, then old-version, then current-version', () => {
    const order = orderSpecsByVersionThenTime([
      entry({ spec: 'Current', onCurrentVersion: true }),
      entry({ spec: 'Empty', dataCount: 0, onCurrentVersion: false, lastChange: null }),
      entry({ spec: 'Old', onCurrentVersion: false }),
    ]);
    expect(order).toEqual(['Empty', 'Old', 'Current']);
  });

  it('keeps every old-version spec ahead of every current-version spec regardless of time', () => {
    // The current-version spec is much older by git time, but the version group dominates.
    const order = orderSpecsByVersionThenTime([
      entry({ spec: 'CurrentButAncient', onCurrentVersion: true, lastChange: 1 }),
      entry({ spec: 'OldButRecent', onCurrentVersion: false, lastChange: 9999 }),
    ]);
    expect(order).toEqual(['OldButRecent', 'CurrentButAncient']);
  });

  it('sorts oldest git time first within a group', () => {
    const order = orderSpecsByVersionThenTime([
      entry({ spec: 'Newer', onCurrentVersion: true, lastChange: 500 }),
      entry({ spec: 'Older', onCurrentVersion: true, lastChange: 100 }),
    ]);
    expect(order).toEqual(['Older', 'Newer']);
  });

  it('treats a null git time as oldest within its group', () => {
    const order = orderSpecsByVersionThenTime([
      entry({ spec: 'Timed', onCurrentVersion: false, lastChange: 100 }),
      entry({ spec: 'NoHistory', onCurrentVersion: false, lastChange: null }),
    ]);
    expect(order).toEqual(['NoHistory', 'Timed']);
  });

  it('breaks equal-time ties alphabetically (stable, deterministic order)', () => {
    const order = orderSpecsByVersionThenTime([
      entry({ spec: 'Charlie', lastChange: 200 }),
      entry({ spec: 'Alpha', lastChange: 200 }),
      entry({ spec: 'Bravo', lastChange: 200 }),
    ]);
    expect(order).toEqual(['Alpha', 'Bravo', 'Charlie']);
  });

  it('does not mutate the input', () => {
    const entries = [entry({ spec: 'B', lastChange: 2 }), entry({ spec: 'A', lastChange: 1 })];
    const snapshot = entries.map(item => item.spec);
    orderSpecsByVersionThenTime(entries);
    expect(entries.map(item => item.spec)).toEqual(snapshot);
  });

  it('returns an empty list for no specs', () => {
    expect(orderSpecsByVersionThenTime([])).toEqual([]);
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
