import { describe, it, expect } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { WclApiService } from '../../../core/services/wcl-api';
import { DataFileApiService } from '../../../core/services/data-file-api';
import { CharacterGear, WclCombatantInfo, WclGearItem } from '../../../core/models/wcl.models';
import {
  GearTransformService, toParseGear, aggregateParseGear, ParseGear,
  extractGear, talentKeyFromTree, toParseRankings,
} from './gear-transform.service';

/* ----------------------------- pure functions ----------------------------- */

describe('toParseRankings', () => {
  it('maps raw rankings to fetchable parses, dropping anonymized names', () => {
    const raw = [
      { name: 'Character 1-2', report: { code: 'r0', fightID: 9 } },
      { name: 'Keep', report: { code: 'r1', fightID: 3 } },
    ];
    expect(toParseRankings(raw, 10)).toEqual([{ player: 'Keep', report_code: 'r1', fight_id: 3 }]);
  });
});

describe('extractGear', () => {
  it('extracts trinkets from slots 12/13 (stripping .jpg) and enchants from any slot', () => {
    const gear: unknown[] = Array(16).fill(null);
    gear[12] = { id: 200, name: 'Trinket A', icon: 'a.jpg' };
    gear[13] = { id: '201', name: 'Trinket B', icon: 'b.jpg' };
    gear[15] = { id: 1, name: 'Wep', permanentEnchant: '8041' };
    const { trinkets, enchants } = extractGear(gear as never);
    expect(trinkets).toEqual([
      { slot: 12, id: 200, name: 'Trinket A', icon: 'a' },
      { slot: 13, id: 201, name: 'Trinket B', icon: 'b' },
    ]);
    expect(enchants).toEqual([{ slot: 15, id: 8041, name: '' }]);
  });
});

describe('talentKeyFromTree', () => {
  it('builds a v2: key from string-sorted nodeIDs', () => {
    expect(talentKeyFromTree([{ nodeID: 90640 }, { nodeID: 90638 }])).toBe('v2:90638,90640');
    expect(talentKeyFromTree(undefined)).toBe('');
  });
});

describe('toParseGear', () => {
  const ranking = { player: 'Ann', report_code: 'rep1', fight_id: 3 };

  it('reduces a found CharacterGear to its fingerprint tagged with the parse identity', () => {
    const gear: CharacterGear = {
      found: true, talent_key: 'v2:1,2',
      trinkets: [{ slot: 12, id: 100, name: 'A', icon: 'inv_a' }],
      enchants: [{ slot: 15, id: 8041, name: 'Sophic' }],
    };
    expect(toParseGear(gear, ranking)).toEqual({
      talent_key: 'v2:1,2',
      trinkets: [{ slot: 12, id: 100, name: 'A', icon: 'inv_a' }],
      enchants: [{ slot: 15, id: 8041, name: 'Sophic' }],
      report_code: 'rep1', fight_id: 3, player_name: 'Ann',
    });
  });

  it('returns null for absent gear', () => {
    expect(toParseGear(null, ranking)).toBeNull();
    expect(toParseGear({ found: false }, ranking)).toBeNull();
  });
});

describe('aggregateParseGear', () => {
  const parse = (overrides: Partial<ParseGear>): ParseGear => ({
    talent_key: 'v2:1,2', trinkets: [], enchants: [],
    report_code: 'rep', fight_id: 1, player_name: 'P', ...overrides,
  });

  it('rolls talent builds, trinkets per slot, and enchants into pct distributions', () => {
    const parses: ParseGear[] = [
      parse({ talent_key: 'v2:A', trinkets: [{ slot: 12, id: 100, name: 'A', icon: 'inv_a' }], enchants: [{ slot: 15, id: 8041, name: 'Soph' }] }),
      parse({ talent_key: 'v2:A', trinkets: [{ slot: 12, id: 100, name: 'A', icon: 'inv_a' }], enchants: [{ slot: 15, id: 8041, name: 'Soph' }] }),
      parse({ talent_key: 'v2:B', trinkets: [{ slot: 12, id: 200, name: 'B', icon: 'inv_b' }], enchants: [] }),
      parse({ talent_key: 'v2:A', trinkets: [{ slot: 13, id: 300, name: 'C', icon: 'inv_c' }], enchants: [{ slot: 15, id: 9000, name: 'Other' }] }),
    ];
    const stats = aggregateParseGear(parses);

    expect(stats.talent_builds[0]).toMatchObject({ key: 'v2:A', pct: 75 });
    expect(stats.talent_builds[1]).toMatchObject({ key: 'v2:B', pct: 25 });
    // slot 12: id 100 in 2/4 = 50%, id 200 in 1/4 = 25%
    expect(stats.trinkets[12]).toEqual([
      { id: 100, name: 'A', icon: 'inv_a', pct: 50 },
      { id: 200, name: 'B', icon: 'inv_b', pct: 25 },
    ]);
    expect(stats.trinkets[13]).toEqual([{ id: 300, name: 'C', icon: 'inv_c', pct: 25 }]);
    // slot 15: 8041 in 2/4 = 50%, 9000 in 1/4 = 25%
    expect(stats.enchants[15]).toEqual([
      { id: 8041, name: 'Soph', pct: 50 },
      { id: 9000, name: 'Other', pct: 25 },
    ]);
  });

  it('ignores non-trinket slots and zero ids', () => {
    const stats = aggregateParseGear([
      parse({ trinkets: [{ slot: 5, id: 1, name: 'X', icon: 'x' }, { slot: 12, id: 0, name: '', icon: '' }] }),
    ]);
    expect(stats.trinkets).toEqual({});
  });

  it('returns empty aggregates for no parses', () => {
    expect(aggregateParseGear([])).toEqual({ talent_builds: [], trinkets: {}, enchants: {} });
  });

  it('records the first-seen parse identity so a build can link to an example parse', () => {
    const stats = aggregateParseGear([
      parse({ talent_key: 'v2:A', report_code: 'rep1', fight_id: 3, player_name: 'Ann' }),
      parse({ talent_key: 'v2:A', report_code: 'rep2', fight_id: 7, player_name: 'Bob' }),
    ]);
    expect(stats.talent_builds[0]).toMatchObject({
      key: 'v2:A', report_code: 'rep1', fight_id: 3, player_name: 'Ann',
    });
  });
});

/* ----------------------------- service (end to end, fake client) ----------------------------- */

function reportFor(playerId: number, playerName: string, fightId: number) {
  return {
    title: 't',
    fights: [{ id: fightId, name: 'Boss', startTime: 0, endTime: 300_000, kill: true, encounterID: 1, friendlyPlayers: [] }],
    masterData: { actors: [{ id: playerId, name: playerName, subType: 'Rogue', server: '' }], abilities: [] },
  };
}

// Raw CombatantInfo: trinket (slot 12) + enchanted weapon (slot 15), both named so
// no gameData name resolution is needed. talentTree node 65 -> key 'v2:65'.
const combatantInfo = (playerId: number): WclCombatantInfo => {
  const gear: WclGearItem[] = Array(16).fill({});
  gear[12] = { id: 100, name: 'A', icon: 't.jpg' };
  gear[15] = { id: 1, name: 'Wep', permanentEnchant: 8041, permanentEnchantName: 'Soph' };
  return { sourceID: playerId, gear, talentTree: [{ nodeID: 65 }] };
};

const wclFake = {
  getRankings: async () => [
    { name: 'P1', report: { code: 'r1', fightID: 1 } },
    { name: 'P2', report: { code: 'r2', fightID: 2 } },
  ],
  getReport: async (code: string) => (code === 'r1' ? reportFor(10, 'P1', 1) : reportFor(20, 'P2', 2)),
  getCombatantInfo: async (code: string) => combatantInfo(code === 'r1' ? 10 : 20),
  getGameNames: async () => ({}),
};

describe('GearTransformService (live, in-browser)', () => {
  it('computes a gear bench aggregated from the top parses', async () => {
    TestBed.configureTestingModule({
      providers: [
        { provide: WclApiService, useValue: wclFake as unknown as WclApiService },
        { provide: DataFileApiService, useValue: {} as unknown as DataFileApiService },
      ],
    });
    const bench = await TestBed.inject(GearTransformService).getGearBench('SubtletyRogue', 1);
    expect(bench).not.toBeNull();
    expect(bench!.sample_count).toBe(2);
    expect(bench!.encounter_name).toBe('Boss');
    expect(bench!.talent_builds[0]).toMatchObject({
      key: 'v2:65', pct: 100, report_code: 'r1', fight_id: 1, player_name: 'P1',
    });
    expect(bench!.trinkets[12]).toEqual([{ id: 100, name: 'A', icon: 't', pct: 100 }]);
    expect(bench!.enchants[15]).toEqual([{ id: 8041, name: 'Soph', pct: 100 }]);
  });

  it('backfills past a private (unfetchable) top parse to keep the sample count full', async () => {
    const candidates = Array.from({ length: 11 }, (_, i) => ({ name: `P${i + 1}`, report: { code: `r${i + 1}`, fightID: i + 1 } }));
    const backfillWcl = {
      ...wclFake,
      getRankings: async () => candidates,
      getReport: async (code: string) => {
        if (code === 'r5') throw new Error('You do not have permission to view this report.');
        const idx = Number(code.slice(1));
        return reportFor(idx * 10, `P${idx}`, idx);
      },
      getCombatantInfo: async () => combatantInfo(10),
    };
    TestBed.configureTestingModule({
      providers: [
        { provide: WclApiService, useValue: backfillWcl as unknown as WclApiService },
        { provide: DataFileApiService, useValue: {} as unknown as DataFileApiService },
      ],
    });
    const bench = await TestBed.inject(GearTransformService).getGearBench('SubtletyRogue', 1);
    // 11 candidates, one private: the 11th backfills the skipped parse to a full 10.
    expect(bench!.sample_count).toBe(10);
  });

  it('returns null when there are no rankings', async () => {
    TestBed.configureTestingModule({
      providers: [
        { provide: WclApiService, useValue: { getRankings: async () => [] } as unknown as WclApiService },
        { provide: DataFileApiService, useValue: {} as unknown as DataFileApiService },
      ],
    });
    expect(await TestBed.inject(GearTransformService).getGearBench('SubtletyRogue', 1)).toBeNull();
  });
});
