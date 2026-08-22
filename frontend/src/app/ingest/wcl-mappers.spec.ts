import { describe, it, expect } from 'vitest';
import {
  encountersForRaids, parseRaidNames, mapClassesToSpecMeta,
  type WclExpansions, type WclGameClasses,
} from './wcl-mappers';

type WclZone = NonNullable<NonNullable<NonNullable<WclExpansions[number]>['zones']>[number]>;

function zone(over: Partial<WclZone> & Pick<WclZone, 'id' | 'name'>): WclZone {
  return { frozen: false, partitions: null, encounters: null, ...over };
}

describe('parseRaidNames', () => {
  it('splits on commas and trims, so the repo variable can be written with spaces', () => {
    expect(parseRaidNames('The Venomous Abyss, Sporefall')).toEqual(['The Venomous Abyss', 'Sporefall']);
  });

  it('yields no raid for unset or blank input, which leaves the dataset alone rather than pruning it', () => {
    expect(parseRaidNames(null)).toEqual([]);
    expect(parseRaidNames('  ,  ')).toEqual([]);
  });
});

describe('encountersForRaids', () => {
  const CURRENT = 53, FROZEN_COPY = 54;
  const expansions: WclExpansions = [
    {
      zones: [
        zone({ id: 46, name: 'VS / DR / MQD', encounters: [{ id: 3176, name: 'Imperator' }] }),
        zone({ id: 50, name: 'Sporefall', partitions: [{ id: 1 }, { id: 2 }], encounters: [{ id: 3159, name: 'Rotmire' }] }),
        zone({ id: CURRENT, name: 'The Venomous Abyss', encounters: [{ id: 3470, name: "Nek'zali" }] }),
        zone({ id: FROZEN_COPY, name: 'The Venomous Abyss', frozen: true, encounters: [{ id: 3480, name: 'Frozen copy' }] }),
      ],
    },
    { zones: [zone({ id: 44, name: 'Manaforge Omega', encounters: [{ id: 3129, name: 'Old' }] })] },
  ];

  it('takes the unfrozen zone when a frozen copy shares the name', () => {
    expect(encountersForRaids(expansions, ['The Venomous Abyss']).map(encounter => encounter.id)).toEqual([3470]);
  });

  it('matches ignoring case and surrounding space, and sorts partitions newest-first', () => {
    const [rotmire] = encountersForRaids(expansions, ['  sporefall ']);
    expect(rotmire).toMatchObject({ id: 3159, zone: 'Sporefall', zoneId: 50, partitionIds: [2, 1] });
  });

  it('keeps the named order so the encounter index leads with the raid named first', () => {
    expect(encountersForRaids(expansions, ['Sporefall', 'The Venomous Abyss']).map(encounter => encounter.id))
      .toEqual([3159, 3470]);
  });

  it('contributes nothing for a name no current zone carries, rather than guessing at a near match', () => {
    expect(encountersForRaids(expansions, ['The Venomous Abyss Complete Raid', 'Manaforge Omega'])).toEqual([]);
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
