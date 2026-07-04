import { describe, it, expect } from 'vitest';
import { mapRankings, filterEncounters, groupEncountersByZone, protectedEncounterIds, mapClassesToSpecMeta, specWclFromMetas } from './wcl-mappers.ts';
import type { WclRawRanking, WclExpansion, IngestEncounter, WclGameClass } from './models/wcl.models.ts';

describe('mapRankings', () => {
  const raw: WclRawRanking[] = [
    { name: 'A', amount: 100, duration: 3000, report: { code: 'r1', fightID: 2 }, server: { name: 'S1' } },
    { name: 'Anon' }, // no report -> anonymous, dropped
    { name: 'B', amount: 90, report: { code: 'r2', fightID: 3 } },
  ];

  it('drops anonymous parses and maps the rest with 1-based ranks', () => {
    const mapped = mapRankings(raw, 10);
    expect(mapped).toHaveLength(2);
    expect(mapped[0]).toMatchObject({ rank: 1, player: 'A', amount: 100, duration_s: 3, report_code: 'r1', fight_id: 2, server: 'S1' });
    expect(mapped[1]).toMatchObject({ rank: 2, player: 'B', report_code: 'r2' });
  });

  it('slices to the requested count after filtering', () => {
    expect(mapRankings(raw, 1)).toHaveLength(1);
  });

  it('drops privacy-anonymized parses (Character <id>-<id>) even when they have a report', () => {
    const withAnon: WclRawRanking[] = [
      { name: 'Real', report: { code: 'r1', fightID: 1 } },
      { name: 'Character 136008374-11633002', report: { code: 'r2', fightID: 2 } }, // anonymized -> dropped
    ];
    const mapped = mapRankings(withAnon, 10);
    expect(mapped.map(ranking => ranking.player)).toEqual(['Real']);
  });
});

describe('filterEncounters', () => {
  it('uses only the first expansion, excludes beta/ptr zones, and sorts partitions descending', () => {
    const expansions: WclExpansion[] = [
      {
        id: 1, name: 'Current', zones: [
          { id: 10, name: 'Raid', partitions: [{ id: 1, name: 'p1' }, { id: 3, name: 'p3' }, { id: 2, name: 'p2' }], encounters: [{ id: 100, name: 'Boss 1' }] },
          { id: 11, name: 'Beta Zone', encounters: [{ id: 200, name: 'Beta Boss' }] },
        ],
      },
      { id: 2, name: 'Older', zones: [{ id: 20, name: 'Old Raid', encounters: [{ id: 300, name: 'Old Boss' }] }] },
    ];
    const encounters = filterEncounters(expansions);
    expect(encounters).toHaveLength(1);
    expect(encounters[0]).toMatchObject({ id: 100, name: 'Boss 1', zone: 'Raid', expansion: 'Current', partitionIds: [3, 2, 1] });
  });

  it('returns [] when there are no expansions', () => {
    expect(filterEncounters([])).toEqual([]);
  });

  // Mirrors the real Midnight worldData: an old tier and a "complete raid" aggregate
  // are frozen (and slip the name patterns), the live raids are frozen:false.
  it('drops frozen zones even when their name matches no exclude pattern, and carries zoneId', () => {
    const expansions: WclExpansion[] = [
      {
        id: 7, name: 'Midnight', zones: [
          { id: 46, name: 'VS / DR / MQD', frozen: false, encounters: [{ id: 3176, name: 'Imperator Averzian' }] },
          { id: 53, name: 'The Venomous Abyss', frozen: true, encounters: [{ id: 3470, name: 'Old Boss' }] },
          { id: 510, name: 'The Venomous Abyss Complete Raid', frozen: true, encounters: [{ id: 3191, name: 'Aggregate' }] },
          { id: 50, name: 'Sporefall', encounters: [{ id: 3159, name: 'Rotmire' }] }, // frozen omitted -> kept
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
    expect(groups.get(46)!.map(encounter => encounter.id)).toEqual([1, 2]);
    expect(groups.get(54)!.map(encounter => encounter.id)).toEqual([3]);
  });
});

describe('protectedEncounterIds', () => {
  it('collects every non-frozen current-expansion id (ignoring name-exclude/probe), and drops frozen + older expansions', () => {
    const expansions: WclExpansion[] = [
      {
        id: 7, name: 'Midnight', zones: [
          { id: 46, name: 'VS / DR / MQD', frozen: false, encounters: [{ id: 3176, name: 'A' }, { id: 3177, name: 'B' }] },
          { id: 47, name: 'Mythic+ Season 1', frozen: false, encounters: [{ id: 112526, name: 'Dungeon' }] }, // name-excluded but still protected
          { id: 53, name: 'The Venomous Abyss', frozen: true, encounters: [{ id: 3470, name: 'Old' }] },
        ],
      },
      { id: 6, name: 'The War Within', zones: [{ id: 44, name: 'Manaforge Omega', frozen: true, encounters: [{ id: 3129, name: 'Old' }] }] },
    ];
    const ids = protectedEncounterIds(expansions);
    expect([...ids].sort((a, b) => a - b)).toEqual([3176, 3177, 112526]);
  });

  it('returns an empty set when there are no expansions', () => {
    expect(protectedEncounterIds([]).size).toBe(0);
  });
});

describe('mapClassesToSpecMeta', () => {
  const classes: WclGameClass[] = [
    { id: 4, name: 'Rogue', slug: 'Rogue', specs: [
      { id: 259, name: 'Assassination', slug: 'Assassination' },
      { id: 261, name: 'Subtlety', slug: 'Subtlety' },
    ] },
    { id: 3, name: 'Hunter', slug: 'Hunter', specs: [
      { id: 253, name: 'Beast Mastery', slug: 'BeastMastery' },
    ] },
    { id: 12, name: 'Demon Hunter', slug: 'DemonHunter', specs: [
      { id: 1473, name: 'Devourer', slug: 'Devourer' }, // a new spec absent from the curated icon map
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
      { id: 4, name: 'Rogue', slug: 'Rogue', specs: [{ id: 261, name: 'Subtlety', slug: 'Subtlety' }] },
    ]);
    expect(specWclFromMetas(metas)['SubtletyRogue']).toEqual(['Rogue', 'Subtlety']);
  });
});
