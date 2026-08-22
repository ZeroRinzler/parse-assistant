import { assert, describe, it, expect } from 'vitest';
import {
  orderSpecsByVersion, specsForRun, orderEncountersByMissingFirst, parsePrioritySpecs, SPEC_LIMIT,
  type SpecOrderEntry,
} from './ordering';

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
    ], []);
    expect(order).toEqual(['Empty', 'Old', 'Current']);
  });

  it('keeps every old-version spec ahead of every current-version spec', () => {
    const order = orderSpecsByVersion([
      entry({ spec: 'CurrentZebra', onCurrentVersion: true }),
      entry({ spec: 'OldApple', onCurrentVersion: false }),
    ], []);
    expect(order).toEqual(['OldApple', 'CurrentZebra']);
  });

  it('orders a group by the injected random key (smaller key first)', () => {
    // Keys are drawn per entry in input order; here Charlie < Bravo < Alpha.
    const keys = [0.1, 0.9, 0.5];
    let next = 0;
    const order = orderSpecsByVersion(
      [entry({ spec: 'Charlie' }), entry({ spec: 'Alpha' }), entry({ spec: 'Bravo' })],
      [],
      () => {
        const key = keys[next++];
        assert.exists(key);
        return key;
      },
    );
    expect(order).toEqual(['Charlie', 'Bravo', 'Alpha']);
  });

  it('with no priority spec, order comes from the shuffle alone', () => {
    const keys = [0.9, 0.1, 0.5]; // Outlaw, Subtlety, Assassination
    let next = 0;
    const order = orderSpecsByVersion(
      [entry({ spec: 'OutlawRogue' }), entry({ spec: 'SubtletyRogue' }), entry({ spec: 'AssassinationRogue' })],
      [],
      () => {
        const key = keys[next++];
        assert.exists(key);
        return key;
      },
    );
    expect(order).toEqual(['SubtletyRogue', 'AssassinationRogue', 'OutlawRogue']);
  });

  it('pins the priority spec first within its bracket, ahead of the randomized rest', () => {
    const order = orderSpecsByVersion(
      [
        entry({ spec: 'OutlawRogue' }),
        entry({ spec: 'SubtletyRogue' }),
        entry({ spec: 'AssassinationRogue' }),
      ],
      ['SubtletyRogue'],
      () => 0,
    );
    expect(order[0]).toBe('SubtletyRogue');
    expect(order.slice(1).sort()).toEqual(['AssassinationRogue', 'OutlawRogue']);
  });

  it('does not pull the priority spec ahead of an earlier (emptier/older-version) bracket', () => {
    const order = orderSpecsByVersion(
      [
        entry({ spec: 'SubtletyRogue', onCurrentVersion: true }),
        entry({ spec: 'EmptySpec', dataCount: 0, onCurrentVersion: false }),
        entry({ spec: 'OldSpec', onCurrentVersion: false }),
      ],
      ['SubtletyRogue'],
    );
    expect(order).toEqual(['EmptySpec', 'OldSpec', 'SubtletyRogue']);
  });

  it('does not mutate the input', () => {
    const entries = [entry({ spec: 'B' }), entry({ spec: 'A' })];
    const snapshot = entries.map(item => item.spec);
    orderSpecsByVersion(entries, []);
    expect(entries.map(item => item.spec)).toEqual(snapshot);
  });

  it('returns an empty list for no specs', () => {
    expect(orderSpecsByVersion([], [])).toEqual([]);
  });

  it('caps a run at SPEC_LIMIT specs, dropping the overflow', () => {
    // One more spec than the cap: specsForRun orders then slices, so the run never exceeds SPEC_LIMIT.
    const entries = Array.from({ length: SPEC_LIMIT + 1 }, (_, i) => entry({ spec: `Spec${i}` }));
    expect(specsForRun(entries, []).selected).toHaveLength(SPEC_LIMIT);
  });

  it('reports every spec in the same order the cap was applied to, so the deferred ones are still logged', () => {
    const entries = Array.from({ length: SPEC_LIMIT + 3 }, (_, i) => entry({ spec: `Spec${i}` }));
    const { ordered, selected } = specsForRun(entries, []);
    expect(ordered).toHaveLength(SPEC_LIMIT + 3);
    expect(ordered.slice(0, SPEC_LIMIT)).toEqual(selected);
    expect([...ordered].sort()).toEqual(entries.map(item => item.spec).sort());
  });

  it('pins a custom priority list in order, ahead of the randomized rest', () => {
    const order = orderSpecsByVersion(
      [entry({ spec: 'OutlawRogue' }), entry({ spec: 'ArmsWarrior' }), entry({ spec: 'SubtletyRogue' })],
      ['ArmsWarrior', 'SubtletyRogue'],
      () => 0,
    );
    expect(order).toEqual(['ArmsWarrior', 'SubtletyRogue', 'OutlawRogue']);
  });
});

describe('parsePrioritySpecs', () => {
  it('splits a comma-separated list, trimming whitespace', () => {
    expect(parsePrioritySpecs('SubtletyRogue, ArmsWarrior')).toEqual(['SubtletyRogue', 'ArmsWarrior']);
  });

  it('falls back to no priority spec for missing input', () => {
    expect(parsePrioritySpecs(undefined)).toEqual([]);
    expect(parsePrioritySpecs(null)).toEqual([]);
    expect(parsePrioritySpecs('')).toEqual([]);
  });

  it('falls back to no priority spec for a blank or malformed list', () => {
    expect(parsePrioritySpecs('  , , ')).toEqual([]);
    expect(parsePrioritySpecs('["SubtletyRogue"]')).toEqual([]);
    expect(parsePrioritySpecs('SubtletyRogue;ArmsWarrior')).toEqual([]);
  });

  it('rejects the whole list when any single token is malformed', () => {
    expect(parsePrioritySpecs('SubtletyRogue,Arms Warrior')).toEqual([]);
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
