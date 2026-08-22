import { assert, describe, it, expect } from 'vitest';
import {
  filterEncounters, groupEncountersByZone, mapClassesToSpecMeta, specWclFromMetas,
  type WclExpansions, type WclGameClasses,
} from './wcl-mappers';
import type { IngestEncounter } from './models/wcl.models';

type WclZone = NonNullable<NonNullable<NonNullable<WclExpansions[number]>['zones']>[number]>;

function zone(over: Partial<WclZone> & Pick<WclZone, 'id' | 'name'>): WclZone {
  return { frozen: false, partitions: null, encounters: null, ...over };
}

describe('filterEncounters', () => {
  it('uses only the first expansion, excludes beta/ptr zones, and sorts partitions descending', () => {
    const expansions: WclExpansions = [
      {
        zones: [
          zone({ id: 10, name: 'Raid', partitions: [{ id: 1 }, { id: 3 }, { id: 2 }], encounters: [{ id: 100, name: 'Boss 1' }] }),
          zone({ id: 11, name: 'Beta Zone', encounters: [{ id: 200, name: 'Beta Boss' }] }),
        ],
      },
      { zones: [zone({ id: 20, name: 'Old Raid', encounters: [{ id: 300, name: 'Old Boss' }] })] },
    ];
    const encounters = filterEncounters(expansions);
    expect(encounters).toHaveLength(1);
    expect(encounters[0]).toMatchObject({ id: 100, name: 'Boss 1', zone: 'Raid', partitionIds: [3, 2, 1] });
  });

  it('returns [] when there are no expansions', () => {
    expect(filterEncounters([])).toEqual([]);
  });

  it('drops a non-frozen per-tier "Complete Raid" aggregate zone by name, keeping the real raid', () => {
    const expansions: WclExpansions = [
      {
        zones: [
          zone({ id: 53, name: 'The Venomous Abyss', frozen: false, encounters: [{ id: 3470, name: 'Boss' }] }),
          zone({ id: 510, name: 'The Venomous Abyss Complete Raid', frozen: false, encounters: [{ id: 3191, name: 'Aggregate' }] }),
        ],
      },
    ];
    expect(filterEncounters(expansions).map(encounter => encounter.id)).toEqual([3470]);
  });

  // Mirrors the real Midnight worldData.
  it('drops frozen zones even when their name matches no exclude pattern, and carries zoneId', () => {
    const expansions: WclExpansions = [
      {
        zones: [
          zone({ id: 46, name: 'VS / DR / MQD', frozen: false, encounters: [{ id: 3176, name: 'Imperator Averzian' }] }),
          zone({ id: 53, name: 'The Venomous Abyss', frozen: true, encounters: [{ id: 3470, name: 'Old Boss' }] }),
          zone({ id: 510, name: 'The Venomous Abyss Complete Raid', frozen: true, encounters: [{ id: 3191, name: 'Aggregate' }] }),
          zone({ id: 50, name: 'Sporefall', frozen: undefined, encounters: [{ id: 3159, name: 'Rotmire' }] }),
        ],
      },
    ];
    const encounters = filterEncounters(expansions);
    expect(encounters.map(encounter => encounter.id).sort((a, b) => a - b)).toEqual([3159, 3176]);
    expect(encounters.find(encounter => encounter.id === 3176)).toMatchObject({ zoneId: 46, zone: 'VS / DR / MQD' });
  });
});

describe('groupEncountersByZone', () => {
  it('groups by zoneId so same-named zones stay separate', () => {
    const encounters = [
      { id: 1, zoneId: 46 }, { id: 2, zoneId: 46 }, { id: 3, zoneId: 54 },
    ] as IngestEncounter[];
    const groups = groupEncountersByZone(encounters);
    expect([...groups.keys()].sort((a, b) => a - b)).toEqual([46, 54]);
    const zone46 = groups.get(46);
    assert.exists(zone46);
    expect(zone46.map(encounter => encounter.id)).toEqual([1, 2]);
    const zone54 = groups.get(54);
    assert.exists(zone54);
    expect(zone54.map(encounter => encounter.id)).toEqual([3]);
  });
});

describe('mapClassesToSpecMeta', () => {
  const classes: WclGameClasses = [
    { name: 'Rogue', slug: 'Rogue', specs: [
      { name: 'Assassination', slug: 'Assassination' },
      { name: 'Subtlety', slug: 'Subtlety' },
    ] },
    { name: 'Hunter', slug: 'Hunter', specs: [
      { name: 'Beast Mastery', slug: 'BeastMastery' },
    ] },
    { name: 'Demon Hunter', slug: 'DemonHunter', specs: [
      { name: 'Devourer', slug: 'Devourer' },
    ] },
  ];

  it('composes the folder key as spec.slug + class.slug and carries the WCL slugs + labels', () => {
    const metas = mapClassesToSpecMeta(classes);
    expect(metas.find(meta => meta.spec === 'SubtletyRogue')).toMatchObject(
      { className: 'Rogue', specName: 'Subtlety', classLabel: 'Rogue', specLabel: 'Subtlety' });
    expect(metas.find(meta => meta.spec === 'BeastMasteryHunter')).toMatchObject(
      { className: 'Hunter', specName: 'BeastMastery', specLabel: 'Beast Mastery' });
  });

  it('derives the class icon formulaically from the lowercased class slug', () => {
    const metas = mapClassesToSpecMeta(classes);
    expect(metas.find(meta => meta.spec === 'SubtletyRogue')?.classIcon).toBe('class_rogue');
    expect(metas.find(meta => meta.spec === 'DevourerDemonHunter')?.classIcon).toBe('class_demonhunter');
  });

  it('leaves the spec icon empty (the orchestrator fills it from the rulebook)', () => {
    const metas = mapClassesToSpecMeta(classes);
    expect(metas.every(meta => meta.specIcon === '')).toBe(true);
  });
});

describe('specWclFromMetas', () => {
  it('projects each spec to [className, specName]', () => {
    const metas = mapClassesToSpecMeta([
      { name: 'Rogue', slug: 'Rogue', specs: [{ name: 'Subtlety', slug: 'Subtlety' }] },
    ]);
    expect(specWclFromMetas(metas)['SubtletyRogue']).toEqual(['Rogue', 'Subtlety']);
  });
});
