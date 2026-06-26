import { describe, it, expect } from 'vitest';
import { orderSpecsByDataAscending, orderEncountersByMissingFirst } from './ordering.ts';

describe('orderSpecsByDataAscending', () => {
  it('puts no-data specs before partial before fully-populated', () => {
    const order = orderSpecsByDataAscending([
      { spec: 'Full', dataCount: 10 },
      { spec: 'Empty', dataCount: 0 },
      { spec: 'Partial', dataCount: 3 },
    ]);
    expect(order).toEqual(['Empty', 'Partial', 'Full']);
  });

  it('breaks ties alphabetically (stable, deterministic order)', () => {
    const order = orderSpecsByDataAscending([
      { spec: 'Charlie', dataCount: 0 },
      { spec: 'Alpha', dataCount: 0 },
      { spec: 'Bravo', dataCount: 0 },
    ]);
    expect(order).toEqual(['Alpha', 'Bravo', 'Charlie']);
  });

  it('does not mutate the input', () => {
    const entries = [
      { spec: 'Full', dataCount: 10 },
      { spec: 'Empty', dataCount: 0 },
    ];
    const snapshot = entries.map(entry => entry.spec);
    orderSpecsByDataAscending(entries);
    expect(entries.map(entry => entry.spec)).toEqual(snapshot);
  });

  it('returns an empty list for no specs', () => {
    expect(orderSpecsByDataAscending([])).toEqual([]);
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
