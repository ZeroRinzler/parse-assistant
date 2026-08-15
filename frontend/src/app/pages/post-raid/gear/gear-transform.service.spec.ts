import { assert, describe, it, expect } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { WclApiService } from '../../../core/services/wcl-api';
import { DataFileApiService } from '../../../core/services/data-file-api';
import { TalentDataService } from '../../../core/services/talent-data';
import { SpecTalents } from '../../../core/models/talent.models';
import { CharacterGear, WclCombatantInfo, WclGearItem } from '../../../core/models/wcl.models';
import { ok, missing, transient } from '../../../core/result';
import {
  GearTransformService, toParseGear, aggregateParseGear, ParseGear, withTalentDiffs,
  aggregateTalents, aggregateTrinkets, aggregateEnchants,
} from './gear-transform.service';
import { talentKeyFromTree, parseTalentKey } from '../../../shared/gear/talent-key';

// Per-slot caps mirrored from the transform service; the boundary tests build one more than the cap.
const MAX_TALENT_BUILDS = 3;
const MAX_TRINKETS_PER_SLOT = 5;
const MAX_ENCHANTS_PER_SLOT = 3;
const TRINKET_1_SLOT = 12;
const TRINKET_2_SLOT = 13;
const ENCHANT_SLOT = 15;
const EXAMPLE_SOURCE_ID = 537;

describe('talentKeyFromTree', () => {
  it('builds a v3: key of entry.rank pairs ordered by entry, ignoring the node', () => {
    // Two parses of one build can report a talent under different nodeIDs, so the node is left out.
    expect(talentKeyFromTree([{ nodeID: 100001, id: 22, rank: 2 }, { nodeID: 90638, id: 11, rank: 1 }]))
      .toBe('v3:11.1,22.2');
    expect(talentKeyFromTree(undefined)).toBe('');
  });

  it('defaults an absent rank to one point and drops nodes with no entry', () => {
    expect(talentKeyFromTree([{ nodeID: 5, id: 50 }, { nodeID: 6 }])).toBe('v3:50.1');
  });

  it('round-trips through parseTalentKey', () => {
    const key = talentKeyFromTree([{ nodeID: 5, id: 50, rank: 2 }]);
    expect(parseTalentKey(key)).toEqual([{ entryId: 50, rank: 2 }]);
  });

  it('reads no picks from a key in any other format', () => {
    expect(parseTalentKey('v2:90638,100001')).toEqual([]);
    expect(parseTalentKey('')).toEqual([]);
  });

  it('gives one key when two parses report the same talents under different node ids', () => {
    const a = talentKeyFromTree([{ nodeID: 10, id: 50, rank: 1 }, { nodeID: 20, id: 60, rank: 1 }]);
    const b = talentKeyFromTree([{ nodeID: 99, id: 50, rank: 1 }, { nodeID: 88, id: 60, rank: 1 }]);
    expect(a).toBe(b);
  });
});

describe('toParseGear', () => {
  const ranking = { player: 'Ann', server: 'Area 52', report_code: 'rep1', fight_id: 3 };

  it('reduces a found CharacterGear to its fingerprint tagged with the parse identity', () => {
    const gear: CharacterGear = {
      talent_key: 'v3:10.1,20.1',
      trinkets: [{ slot: 12, id: 100, name: 'A', icon: 'inv_a' }],
      enchants: [{ slot: 15, id: 8041, name: 'Sophic' }],
    };
    expect(toParseGear(gear, ranking, 537)).toEqual({
      talent_key: 'v3:10.1,20.1',
      trinkets: [{ slot: 12, id: 100, name: 'A', icon: 'inv_a' }],
      enchants: [{ slot: 15, id: 8041, name: 'Sophic' }],
      report_code: 'rep1', fight_id: 3, player_name: 'Ann', source_id: 537,
    });
  });

});

function gearParse(overrides: Partial<ParseGear>): ParseGear {
  return {
    talent_key: 'v3:10.1,20.1', trinkets: [], enchants: [],
    report_code: 'rep', fight_id: 1, player_name: 'P', source_id: 1, ...overrides,
  };
}

describe('aggregateTalents', () => {
  it('ranks builds by frequency, tags the first-seen example, and is empty for no parses', () => {
    expect(aggregateTalents([])).toEqual([]);

    const builds = aggregateTalents([
      gearParse({ talent_key: 'v3:10.1', report_code: 'rep1', fight_id: 3, player_name: 'Ann', source_id: EXAMPLE_SOURCE_ID }),
      gearParse({ talent_key: 'v3:10.1', report_code: 'rep2', fight_id: 7, player_name: 'Bob', source_id: 99 }),
      gearParse({ talent_key: 'v3:11.1' }),
    ]);
    expect(builds[0]).toMatchObject({ key: 'v3:10.1', pct: 67, report_code: 'rep1', source_id: EXAMPLE_SOURCE_ID });
    expect(builds[1]).toMatchObject({ key: 'v3:11.1', pct: 33 });
  });

  it('keeps builds that fill the same slot with a different talent apart', () => {
    const builds = aggregateTalents([
      gearParse({ talent_key: 'v3:10.1' }),
      gearParse({ talent_key: 'v3:11.1' }),
    ]);
    expect(builds).toHaveLength(2);
  });

  it('ignores parses with no talent key', () => {
    expect(aggregateTalents([gearParse({ talent_key: '' })])).toEqual([]);
  });

  it('keeps at most MAX_TALENT_BUILDS distinct builds', () => {
    const parses = Array.from({ length: MAX_TALENT_BUILDS + 1 }, (_, i) => gearParse({ talent_key: `v3:${i}.1` }));
    expect(aggregateTalents(parses)).toHaveLength(MAX_TALENT_BUILDS);
  });
});

describe('aggregateTrinkets', () => {
  it('buckets per slot 12/13 by frequency and ignores non-trinket slots and zero ids', () => {
    const trinkets = aggregateTrinkets([
      gearParse({ trinkets: [{ slot: TRINKET_1_SLOT, id: 100, name: 'A', icon: 'inv_a' }] }),
      gearParse({ trinkets: [{ slot: TRINKET_1_SLOT, id: 100, name: 'A', icon: 'inv_a' }] }),
      gearParse({ trinkets: [{ slot: TRINKET_1_SLOT, id: 200, name: 'B', icon: 'inv_b' }] }),
      gearParse({ trinkets: [{ slot: TRINKET_2_SLOT, id: 300, name: 'C', icon: 'inv_c' }] }),
    ]);
    expect(trinkets[TRINKET_1_SLOT]).toEqual([
      { id: 100, name: 'A', icon: 'inv_a', pct: 50 },
      { id: 200, name: 'B', icon: 'inv_b', pct: 25 },
    ]);
    expect(trinkets[TRINKET_2_SLOT]).toEqual([{ id: 300, name: 'C', icon: 'inv_c', pct: 25 }]);
  });

  it('drops a non-trinket slot and a zero-id trinket, and is empty for no parses', () => {
    expect(aggregateTrinkets([])).toEqual({});
    const trinkets = aggregateTrinkets([
      gearParse({ trinkets: [{ slot: 5, id: 1, name: 'X', icon: 'x' }, { slot: TRINKET_1_SLOT, id: 0, name: '', icon: '' }] }),
    ]);
    expect(trinkets).toEqual({});
  });

  it('keeps at most MAX_TRINKETS_PER_SLOT trinkets in a slot', () => {
    const parses = Array.from({ length: MAX_TRINKETS_PER_SLOT + 1 }, (_, i) =>
      gearParse({ trinkets: [{ slot: TRINKET_1_SLOT, id: 100 + i, name: `T${i}`, icon: `t${i}` }] }));
    expect(aggregateTrinkets(parses)[TRINKET_1_SLOT]).toHaveLength(MAX_TRINKETS_PER_SLOT);
  });

  it('replaces a first-seen empty name (failed lookup) with a later real name, count unchanged', () => {
    const trinkets = aggregateTrinkets([
      gearParse({ trinkets: [{ slot: TRINKET_1_SLOT, id: 100, name: '', icon: 'inv_a' }] }),
      gearParse({ trinkets: [{ slot: TRINKET_1_SLOT, id: 100, name: 'A', icon: 'inv_a' }] }),
    ]);
    // Both parses ran trinket 100, so pct 100 confirms the empty-name parse still counted.
    expect(trinkets[TRINKET_1_SLOT]).toEqual([{ id: 100, name: 'A', icon: 'inv_a', pct: 100 }]);
  });
});

describe('aggregateEnchants', () => {
  it('buckets per slot by frequency and ignores zero ids', () => {
    const enchants = aggregateEnchants([
      gearParse({ enchants: [{ slot: ENCHANT_SLOT, id: 8041, name: 'Soph' }] }),
      gearParse({ enchants: [{ slot: ENCHANT_SLOT, id: 8041, name: 'Soph' }] }),
      gearParse({ enchants: [{ slot: ENCHANT_SLOT, id: 9000, name: 'Other' }] }),
      gearParse({ enchants: [{ slot: ENCHANT_SLOT, id: 0, name: '' }] }),
    ]);
    expect(enchants[ENCHANT_SLOT]).toEqual([
      { id: 8041, name: 'Soph', pct: 50 },
      { id: 9000, name: 'Other', pct: 25 },
    ]);
  });

  it('is empty for no parses', () => {
    expect(aggregateEnchants([])).toEqual({});
  });

  it('keeps at most MAX_ENCHANTS_PER_SLOT enchants in a slot', () => {
    const parses = Array.from({ length: MAX_ENCHANTS_PER_SLOT + 1 }, (_, i) =>
      gearParse({ enchants: [{ slot: ENCHANT_SLOT, id: 8041 + i, name: `E${i}` }] }));
    expect(aggregateEnchants(parses)[ENCHANT_SLOT]).toHaveLength(MAX_ENCHANTS_PER_SLOT);
  });

  it('replaces a first-seen empty name (failed lookup) with a later real name, count unchanged', () => {
    const enchants = aggregateEnchants([
      gearParse({ enchants: [{ slot: ENCHANT_SLOT, id: 8041, name: '' }] }),
      gearParse({ enchants: [{ slot: ENCHANT_SLOT, id: 8041, name: 'Soph' }] }),
    ]);
    // Both parses ran enchant 8041, so pct 100 confirms the empty-name parse still counted.
    expect(enchants[ENCHANT_SLOT]).toEqual([{ id: 8041, name: 'Soph', pct: 100 }]);
  });
});

describe('aggregateParseGear', () => {
  it('composes the three per-facet aggregators', () => {
    const parses = [
      gearParse({ talent_key: 'v3:10.1', trinkets: [{ slot: TRINKET_1_SLOT, id: 100, name: 'A', icon: 'inv_a' }], enchants: [{ slot: ENCHANT_SLOT, id: 8041, name: 'Soph' }] }),
    ];
    expect(aggregateParseGear(parses)).toEqual({
      talent_builds: aggregateTalents(parses),
      trinkets: aggregateTrinkets(parses),
      enchants: aggregateEnchants(parses),
    });
  });
});

describe('withTalentDiffs', () => {
  const talents: SpecTalents = { 10: { name: 'A', icon: 'a' }, 11: { name: 'B', icon: 'b' } };
  const builds = () => [
    { key: 'v3:10.1', pct: 60, report_code: 'r1', fight_id: 1, player_name: 'P1', source_id: 1, diff: [] },
    { key: 'v3:11.1', pct: 40, report_code: 'r2', fight_id: 2, player_name: 'P2', source_id: 2, diff: [] },
  ];

  it('bakes each alt build\'s diff against the most common build, leaving the most common one empty', () => {
    const out = withTalentDiffs(builds(), ok(talents));
    assert.exists(out[0]);
    expect(out[0].diff).toEqual([]);
    assert.exists(out[1]);
    expect(out[1].diff).toEqual([
      { kind: 'added', talent: talents[11] },
      { kind: 'dropped', talent: talents[10] },
    ]);
  });

  it('leaves builds untouched whether the spec has no dump entry or the dump failed to load', () => {
    expect(withTalentDiffs(builds(), missing('No talent data for this spec.'))).toEqual(builds());
    expect(withTalentDiffs(builds(), transient('WCL is unreachable right now.'))).toEqual(builds());
  });
});

function reportFor(playerId: number, playerName: string, fightId: number) {
  return {
    title: 't',
    fights: [{ id: fightId, name: 'Boss', startTime: 0, endTime: 300_000, kill: true, encounterID: 1, friendlyPlayers: [] }],
    masterData: { actors: [{ id: playerId, name: playerName, subType: 'Rogue', server: '' }], abilities: [] },
  };
}

const combatantInfo = (playerId: number): WclCombatantInfo => {
  const gear = Array<WclGearItem>(16).fill({});
  gear[12] = { id: 100, name: 'A', icon: 't.jpg' };
  gear[15] = { id: 1, name: 'Wep', permanentEnchant: '8041' };
  return { sourceID: playerId, gear, talentTree: [{ nodeID: 65, id: 650, rank: 1 }] };
};

const wclFake = {
  // getRankings returns the raw WCL envelope ({ rankings }); the transform unwraps it.
  getRankings: async () => ({
    rankings: [
      { name: 'P1', report: { code: 'r1', fightID: 1 } },
      { name: 'P2', report: { code: 'r2', fightID: 2 } },
    ],
  }),
  getReport: async (code: string) => (code === 'r1' ? reportFor(10, 'P1', 1) : reportFor(20, 'P2', 2)),
  // getCombatantInfo returns the raw events array; the transform selects the player's event.
  getCombatantInfo: async (code: string) => [combatantInfo(code === 'r1' ? 10 : 20)],
  getGameNames: async () => ({ e8041: { id: 8041, name: 'Soph' } }),
};

const talentDataFake = {
  getTalents: async () => missing('No talent data for this spec.'),
} as unknown as TalentDataService;

describe('GearTransformService (live, in-browser)', () => {
  it('computes a gear bench aggregated from the top parses', async () => {
    TestBed.configureTestingModule({
      providers: [
        { provide: WclApiService, useValue: wclFake as unknown as WclApiService },
        { provide: DataFileApiService, useValue: {} as unknown as DataFileApiService },
        { provide: TalentDataService, useValue: talentDataFake },
      ],
    });
    const bench = await TestBed.inject(GearTransformService).getBench('SubtletyRogue', 1);
    expect(bench.ok).toBe(true);
    if (!bench.ok) return;
    expect(bench.value.sample_count).toBe(2);
    expect(bench.value.encounter_name).toBe('Boss');
    expect(bench.value.talent_builds[0]).toMatchObject({
      key: 'v3:650.1', pct: 100, report_code: 'r1', fight_id: 1, player_name: 'P1', source_id: 10,
    });
    expect(bench.value.trinkets[12]).toEqual([{ id: 100, name: 'A', icon: 't', pct: 100 }]);
    expect(bench.value.enchants[15]).toEqual([{ id: 8041, name: 'Soph', pct: 100 }]);
  });

  it('bakes talent diffs into the bench when the dump carries the spec', async () => {
    const BASELINE_ENTRY = 650;
    const ALT_ENTRY = 651;
    const talents: SpecTalents = {
      [BASELINE_ENTRY]: { name: 'A', icon: 'a' },
      [ALT_ENTRY]: { name: 'B', icon: 'b' },
    };
    const splitBuildWcl = {
      ...wclFake,
      getCombatantInfo: async (code: string) => [{
        ...combatantInfo(code === 'r1' ? 10 : 20),
        talentTree: [{ nodeID: 65, id: code === 'r1' ? BASELINE_ENTRY : ALT_ENTRY, rank: 1 }],
      }],
    };
    TestBed.configureTestingModule({
      providers: [
        { provide: WclApiService, useValue: splitBuildWcl as unknown as WclApiService },
        { provide: DataFileApiService, useValue: {} as unknown as DataFileApiService },
        { provide: TalentDataService, useValue: { getTalents: async () => ok(talents) } as unknown as TalentDataService },
      ],
    });
    const bench = await TestBed.inject(GearTransformService).getBench('SubtletyRogue', 1);
    expect(bench.ok).toBe(true);
    if (!bench.ok) return;
    assert.exists(bench.value.talent_builds[1]);
    expect(bench.value.talent_builds[1].diff).toEqual([
      { kind: 'added', talent: talents[ALT_ENTRY] },
      { kind: 'dropped', talent: talents[BASELINE_ENTRY] },
    ]);
  });

  it('leaves the bench talent builds diff-free when the dump carries no entry for the spec', async () => {
    TestBed.configureTestingModule({
      providers: [
        { provide: WclApiService, useValue: wclFake as unknown as WclApiService },
        { provide: DataFileApiService, useValue: {} as unknown as DataFileApiService },
        { provide: TalentDataService, useValue: talentDataFake },
      ],
    });
    const bench = await TestBed.inject(GearTransformService).getBench('SubtletyRogue', 1);
    expect(bench.ok).toBe(true);
    if (bench.ok) expect(bench.value.talent_builds.every(build => (build.diff ?? []).length === 0)).toBe(true);
  });

  it('backfills past a private (unfetchable) top parse to keep the sample count full', async () => {
    const candidates = Array.from({ length: 11 }, (_, i) => ({ name: `P${i + 1}`, report: { code: `r${i + 1}`, fightID: i + 1 } }));
    const backfillWcl = {
      ...wclFake,
      getRankings: async () => ({ rankings: candidates }),
      getReport: async (code: string) => {
        if (code === 'r5') throw new Error('You do not have permission to view this report.');
        const idx = Number(code.slice(1));
        return reportFor(idx * 10, `P${idx}`, idx);
      },
      getCombatantInfo: async () => [combatantInfo(10)],
    };
    TestBed.configureTestingModule({
      providers: [
        { provide: WclApiService, useValue: backfillWcl as unknown as WclApiService },
        { provide: DataFileApiService, useValue: {} as unknown as DataFileApiService },
        { provide: TalentDataService, useValue: talentDataFake },
      ],
    });
    const bench = await TestBed.inject(GearTransformService).getBench('SubtletyRogue', 1);
    // 11 candidates, one private: the 11th backfills the skipped parse to a full 10.
    expect(bench.ok).toBe(true);
    if (bench.ok) expect(bench.value.sample_count).toBe(10);
  });

  it('bakes the same-named raider sitting on the ranked realm, not the first name match', async () => {
    const TWIN_NAME = 'P1';
    const DECOY_ID = 10;
    const RANKED_ID = 11;
    const RANKED_TALENT_ENTRY = 651;
    const twinReport = {
      title: 't',
      fights: [{ id: 1, name: 'Boss', startTime: 0, endTime: 300_000, kill: true, encounterID: 1, friendlyPlayers: [] }],
      masterData: {
        actors: [
          { id: DECOY_ID, name: TWIN_NAME, subType: 'Rogue', server: 'Twisting Nether' },
          { id: RANKED_ID, name: TWIN_NAME, subType: 'Rogue', server: 'Area 52' },
        ],
        abilities: [],
      },
    };
    const twinWcl = {
      ...wclFake,
      getRankings: async () => ({ rankings: [{ name: TWIN_NAME, server: { name: 'Area-52' }, report: { code: 'r1', fightID: 1 } }] }),
      getReport: async () => twinReport,
      getCombatantInfo: async () => [
        combatantInfo(DECOY_ID),
        { ...combatantInfo(RANKED_ID), talentTree: [{ nodeID: 65, id: RANKED_TALENT_ENTRY, rank: 1 }] },
      ],
    };
    TestBed.configureTestingModule({
      providers: [
        { provide: WclApiService, useValue: twinWcl as unknown as WclApiService },
        { provide: DataFileApiService, useValue: {} as unknown as DataFileApiService },
        { provide: TalentDataService, useValue: talentDataFake },
      ],
    });
    const bench = await TestBed.inject(GearTransformService).getBench('SubtletyRogue', 1);
    expect(bench.ok).toBe(true);
    if (!bench.ok) return;
    expect(bench.value.talent_builds[0]).toMatchObject({ key: `v3:${RANKED_TALENT_ENTRY}.1`, source_id: RANKED_ID });
  });

  it('is a missing error when there are no rankings', async () => {
    TestBed.configureTestingModule({
      providers: [
        { provide: WclApiService, useValue: { getRankings: async () => ({ rankings: [] }) } as unknown as WclApiService },
        { provide: DataFileApiService, useValue: {} as unknown as DataFileApiService },
        { provide: TalentDataService, useValue: talentDataFake },
      ],
    });
    expect(await TestBed.inject(GearTransformService).getBench('SubtletyRogue', 1))
      .toEqual(missing('Not yet ingested.'));
  });
});
