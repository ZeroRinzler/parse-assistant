import { describe, it, expect } from 'vitest';
import { extractGear, mapRankings, filterEncounters, parseEnchantResults, SPEC_TO_WCL } from './wcl-mappers.ts';
import type { WclRawRanking, WclExpansion } from './models/wcl.models.ts';

describe('extractGear', () => {
  it('reads trinkets from slots 12/13 and enchants from permanentEnchant (string ids)', () => {
    const gear = [] as NonNullable<WclRawRanking['gear']>;
    gear[2] = { id: 50, name: 'Ring', permanentEnchant: '200' } as never; // enchant id arrives as a string
    gear[12] = { id: 100, name: 'Trinket 1' } as never;
    gear[13] = { id: 101, name: 'Trinket 2' } as never;

    const { trinkets, enchants } = extractGear({ gear });
    expect(trinkets).toEqual([
      { slot: 12, id: 100, name: 'Trinket 1' },
      { slot: 13, id: 101, name: 'Trinket 2' },
    ]);
    // permanentEnchantName is never populated by WCL -> name left blank for later backfill.
    expect(enchants).toEqual([{ slot: 2, id: 200, name: '' }]);
  });

  it('returns empty arrays for missing gear', () => {
    expect(extractGear({})).toEqual({ trinkets: [], enchants: [] });
  });
});

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
});

describe('parseEnchantResults', () => {
  it('keeps only ids that resolved to a non-empty trimmed name', () => {
    const gameData = { e200: { id: 200, name: '  Enchant A  ' }, e201: null, e202: { id: 202, name: '' } };
    const names = parseEnchantResults(gameData, [200, 201, 202]);
    expect([...names.entries()]).toEqual([[200, 'Enchant A']]);
  });
});

describe('SPEC_TO_WCL', () => {
  it('maps a spec folder name to [className, specName]', () => {
    expect(SPEC_TO_WCL['SubtletyRogue']).toEqual(['Rogue', 'Subtlety']);
  });
});
