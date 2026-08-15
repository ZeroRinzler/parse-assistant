import { assert, describe, it, expect } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { WclApiService } from '../../../core/services/wcl-api';
import { DataFileApiService } from '../../../core/services/data-file-api';
import {
  DefensiveTransformService,
  defensiveSpellIds, defensivePlanMeta, summarizeDefensiveCasts,
  findParseDefensiveWindows, clusterDefensiveWindows, buildDefensiveBenchmark,
  aggregateDefensiveBenchmarks,
  windowDamageBreakdown, clusterDamageStats, clusterAbilityBreakdown,
  ParseDefWindow, ParseDefensiveSummary,
} from './defensive-transform.service';
import { applyBuff, removeBuff, damageTaken, cast } from '../../../../testing/builders/events';
import { rulebook } from '../../../../testing/builders/rulebook';
import { CLOAK_OF_SHADOWS, EVASION } from '../../../../testing/spell-ids';
import { WCL_SYNTHETIC_SOURCE_FALLBACK_ID, withRelativeS } from '../../../shared/analysis/wcl-projections';
import { ok } from '../../../core/result';
import { buildAuraWindows } from '../../../shared/analysis/aura-windows';

/** Fixture events build against a fight-start of 0, so stamping is a pass-through to seconds. */
const timed = withRelativeS;

// Enemy-side identifiers for the damage-taken fixtures (not player abilities, so local).
const BOSS_HIT = 700;       // an enemy ability id the player takes damage from
const ADD_HIT = 701;
const BOSS_ACTOR = 9;       // report actor id of the boss
const ADD_ACTOR = 8;        // report actor id of an add
const BOSS_GAME_ID = 6666;  // stable gameID the boss actor maps to
const ADD_GAME_ID = 5555;   // stable gameID the add actor maps to

const CLOAK = { name: 'Cloak of Shadows', spell_id: CLOAK_OF_SHADOWS, cooldown: 120, duration: 5 };
const FIGHT_DUR_S = 300;  // standard fight length used across the per-parse summary fixtures

describe('defensiveSpellIds', () => {
  it('maps defensive names to spell ids, skipping missing ids', () => {
    expect(defensiveSpellIds([CLOAK, { name: 'NoId', spell_id: 0, cooldown: 60 }]))
      .toEqual({ 'Cloak of Shadows': CLOAK_OF_SHADOWS });
  });
});

describe('defensivePlanMeta', () => {
  it('carries metadata with nullable defaults', () => {
    expect(defensivePlanMeta([{ name: 'Evasion', spell_id: EVASION, cooldown: 120 }]))
      .toEqual([{ name: 'Evasion', spell_id: EVASION, cooldown: 120, usage_rule: null, talent_gated: false }]);
  });
});

describe('summarizeDefensiveCasts', () => {
  it('builds one use per buff window and detects holds > 8s past cooldown', () => {
    const FIRST_USE_S = 10, FIRST_REMOVE_S = 15;
    const SECOND_USE_S = 200, SECOND_REMOVE_S = 205;
    const HELD_INDEX = 2;  // 1-based ordinal of the held (second) use
    // The second use lands SECOND_USE_S - (FIRST_USE_S + cooldown) past its reset, well over 8s.
    const EXPECTED_DELAY_S = SECOND_USE_S - (FIRST_USE_S + CLOAK.cooldown);
    const windows = buildAuraWindows(timed([
      applyBuff(CLOAK_OF_SHADOWS, FIRST_USE_S), removeBuff(CLOAK_OF_SHADOWS, FIRST_REMOVE_S),
      applyBuff(CLOAK_OF_SHADOWS, SECOND_USE_S), removeBuff(CLOAK_OF_SHADOWS, SECOND_REMOVE_S),
    ], 0));
    const summaries = summarizeDefensiveCasts([CLOAK], windows, [], FIGHT_DUR_S);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ name: 'Cloak of Shadows', uses: 2, first_cast_s: FIRST_USE_S, cast_pattern: 'hold' });
    // cast_index is 1-based (the 2nd use), matching rotation + the runtime's -1 decode.
    assert.exists(summaries[0]);
    expect(summaries[0].hold_windows).toEqual([{ cast_index: HELD_INDEX, actual_s: SECOND_USE_S, delay_s: EXPECTED_DELAY_S }]);
  });

  it('falls back to explicit casts when no buff windows exist', () => {
    const summaries = summarizeDefensiveCasts([CLOAK], new Map(), timed([cast(CLOAK_OF_SHADOWS, 12)], 0), 300);
    expect(summaries[0]).toMatchObject({ uses: 1, first_cast_s: 12, cast_pattern: 'on_cooldown' });
  });
});

describe('findParseDefensiveWindows', () => {
  it('slices damage taken by the buff span (inclusive end, amount + absorbed) and picks the dominant enemy', () => {
    const windows = buildAuraWindows(timed([applyBuff(CLOAK_OF_SHADOWS, 10), removeBuff(CLOAK_OF_SHADOWS, 15)], 0));
    const BOSS_ABSORB = 250;
    const result = findParseDefensiveWindows(
      timed([
        damageTaken(BOSS_HIT, 12, 500, { source: BOSS_ACTOR, absorbed: BOSS_ABSORB }),
        damageTaken(ADD_HIT, 15, 200, { source: ADD_ACTOR }), // at the exact remove second: the inclusive end must count it
        damageTaken(BOSS_HIT, 100, 999, { source: BOSS_ACTOR }),
      ], 0),
      300, windows, [CLOAK], new Map([[BOSS_ACTOR, BOSS_GAME_ID], [ADD_ACTOR, ADD_GAME_ID]]),
    );
    expect(result).toHaveLength(1);
    // window damage = (500 + 250 absorbed) + 200 at the inclusive end = 950.
    expect(result[0]).toMatchObject({ defensive_name: 'Cloak of Shadows', spell_id: CLOAK_OF_SHADOWS, window_damage: 950, ref_game_id: BOSS_GAME_ID });
    assert.exists(result[0]);
    expect(result[0].ability_breakdown[0]).toMatchObject({ spell_id: BOSS_HIT, damage: 750 });
  });

  it('runs an open buff to fight end (no rulebook duration)', () => {
    const windows = buildAuraWindows(timed([applyBuff(CLOAK_OF_SHADOWS, 10)], 0)); // no remove
    const result = findParseDefensiveWindows(
      timed([damageTaken(BOSS_HIT, 50, 400, { source: BOSS_ACTOR })], 0), 300, windows, [CLOAK], new Map([[BOSS_ACTOR, BOSS_GAME_ID]]),
    );
    assert.exists(result[0]);
    expect(result[0].window_length_s).toBe(290); // 10 -> 300 (fight end), not 10 + duration
    assert.exists(result[0]);
    expect(result[0].window_damage).toBe(400);
  });

  it('includes a hit landing at the exact applybuff millisecond', () => {
    // A hit at the exact buff-apply ms must count: rebuilding the bound from seconds overshoots (2.007 * 1000 = 2007.0000000000002).
    const APPLY_MS = 2007;
    const HIT_DAMAGE = 500;
    const buffApply = { ...applyBuff(CLOAK_OF_SHADOWS, 0), timestamp: APPLY_MS };
    const hit = { ...damageTaken(BOSS_HIT, 0, HIT_DAMAGE, { source: BOSS_ACTOR }), timestamp: APPLY_MS };
    const windows = buildAuraWindows(timed([buffApply], 0));
    const result = findParseDefensiveWindows(timed([hit], 0), FIGHT_DUR_S, windows, [CLOAK], new Map([[BOSS_ACTOR, BOSS_GAME_ID]]));
    expect(result).toHaveLength(1);
    assert.exists(result[0]);
    expect(result[0].window_damage).toBe(HIT_DAMAGE);
  });
});

describe('windowDamageBreakdown', () => {
  // hit = [timestampMs, damage, abilityId, sourceId]
  type Hit = [number, number, number, number | null];
  it('sums damage per ability id, highest first, ignoring id 0', () => {
    const hits: Hit[] = [
      [0, 500, BOSS_HIT, BOSS_ACTOR], [0, 200, ADD_HIT, ADD_ACTOR], [0, 100, BOSS_HIT, BOSS_ACTOR], [0, 999, 0, null],
    ];
    expect(windowDamageBreakdown(hits)).toEqual([{ spell_id: BOSS_HIT, damage: 600 }, { spell_id: ADD_HIT, damage: 200 }]);
  });

  it('keeps only the top 6 damage sources (boundary)', () => {
    const TOP_N = 6;
    const SOURCE_COUNT = 7; // one more than the cap
    const hits: Hit[] = Array.from({ length: SOURCE_COUNT }, (_, i) => [0, (i + 1) * 100, BOSS_HIT + i, BOSS_ACTOR]);
    expect(windowDamageBreakdown(hits)).toHaveLength(TOP_N);
  });

  it('folds distinct synthetic ids that normalize together into one summed row', () => {
    const SYNTH_A = -3, SYNTH_B = -7;  // distinct negatives, both normalize to the synthetic catch-all
    const DMG_A = 300, DMG_B = 200;
    const hits: Hit[] = [[0, DMG_A, SYNTH_A, null], [0, DMG_B, SYNTH_B, null]];
    expect(windowDamageBreakdown(hits)).toEqual([{ spell_id: WCL_SYNTHETIC_SOURCE_FALLBACK_ID, damage: DMG_A + DMG_B }]);
  });
});

describe('clusterDamageStats', () => {
  it('reports avg/stddev/min/max over the window damages, rounded', () => {
    const LOW = 700;
    const HIGH = 900;
    expect(clusterDamageStats([LOW, HIGH])).toEqual({ dmg_avg: 800, dmg_stddev: Math.round(Math.sqrt(20000)), dmg_min: LOW, dmg_max: HIGH });
  });
});

describe('clusterAbilityBreakdown', () => {
  const member = (abilities: { spell_id: number; damage: number }[], parseIndex = 0): ParseDefWindow => ({
    time_s: 10, window_length_s: 5, window_damage: 700, parse_index: parseIndex,
    defensive_name: 'Cloak of Shadows', spell_id: CLOAK_OF_SHADOWS, ref_game_id: BOSS_GAME_ID, ability_breakdown: abilities,
  });

  it('keeps an ability present in a majority of parses with avg/min/max', () => {
    const out = clusterAbilityBreakdown([
      member([{ spell_id: BOSS_HIT, damage: 400 }], 0), member([{ spell_id: BOSS_HIT, damage: 600 }], 1),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ spell_id: BOSS_HIT, avg_damage: 500, min_damage: 400, max_damage: 600 });
  });

  it('drops an ability below the parse-majority share (boundary)', () => {
    // 1 of 3 parses carries ADD_HIT -> 0.33 < 0.5 majority -> dropped.
    const out = clusterAbilityBreakdown([
      member([{ spell_id: BOSS_HIT, damage: 500 }], 0), member([{ spell_id: BOSS_HIT, damage: 500 }], 1),
      member([{ spell_id: ADD_HIT, damage: 500 }], 2),
    ]);
    expect(out.map(ability => ability.spell_id)).toEqual([BOSS_HIT]);
  });

  it('gates by DISTINCT parses, not window entries (1 of 4 does not surface)', () => {
    // 4 distinct parses share BOSS_HIT; only parse 0 carries ADD_HIT -> 0.25 < 0.5 majority -> dropped.
    const out = clusterAbilityBreakdown([
      member([{ spell_id: BOSS_HIT, damage: 500 }, { spell_id: ADD_HIT, damage: 100 }], 0),
      member([{ spell_id: BOSS_HIT, damage: 500 }], 1),
      member([{ spell_id: BOSS_HIT, damage: 500 }], 2),
      member([{ spell_id: BOSS_HIT, damage: 500 }], 3),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ spell_id: BOSS_HIT });
  });

  it('counts a parse contributing an ability across two of its windows once, summing its damage', () => {
    const FIRST_S = 400, SECOND_S = 300;  // one parse's two windows in the cluster
    const OTHER = 500;
    const EXPECTED_AVG = Math.round((FIRST_S + SECOND_S + OTHER) / 2);  // mean over 2 parses' summed damage
    const out = clusterAbilityBreakdown([
      member([{ spell_id: BOSS_HIT, damage: FIRST_S }], 0),
      member([{ spell_id: BOSS_HIT, damage: SECOND_S }], 0),
      member([{ spell_id: BOSS_HIT, damage: OTHER }], 1),
    ]);
    expect(out[0]).toMatchObject({ spell_id: BOSS_HIT, avg_damage: EXPECTED_AVG, min_damage: OTHER, max_damage: FIRST_S + SECOND_S });
  });
});

describe('clusterDefensiveWindows', () => {
  const window = (timeS: number, parseIndex: number): ParseDefWindow => ({
    time_s: timeS, window_length_s: 5, window_damage: 700, parse_index: parseIndex,
    defensive_name: 'Cloak of Shadows', spell_id: CLOAK_OF_SHADOWS, ref_game_id: BOSS_GAME_ID, ability_breakdown: [{ spell_id: BOSS_HIT, damage: 500 }],
  });

  it('emits a per-defensive cluster present in a majority of distinct parses, with majority ref enemy', () => {
    const out = clusterDefensiveWindows([window(10, 0), window(11, 1)], 2);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ time_s: 10.5, defensive_name: 'Cloak of Shadows', spell_id: CLOAK_OF_SHADOWS, dmg_avg: 700, ref_game_id: BOSS_GAME_ID });
    assert.exists(out[0]);
    expect(out[0].ability_breakdown[0]).toMatchObject({ spell_id: BOSS_HIT, avg_damage: 500 });
  });

  it('keeps a window in exactly half the parses, drops one just below (majority boundary)', () => {
    const five = [window(10, 0), window(11, 1), window(10, 2), window(12, 3), window(11, 4)];
    expect(clusterDefensiveWindows(five, 10)).toHaveLength(1);
    const four = [window(10, 0), window(11, 1), window(10, 2), window(12, 3)];
    expect(clusterDefensiveWindows(four, 10)).toHaveLength(0);
  });

  it('surfaces a consensus window regardless of how little damage was taken', () => {
    const low = [window(10, 0), window(11, 1)];
    expect(clusterDefensiveWindows(low, 2)).toHaveLength(1);
  });
});

describe('buildDefensiveBenchmark', () => {
  it('derives first-cast / gap / uses-per-min and the total/used sample split', () => {
    const TOTAL_PARSES = 3;   // 2 users of 3 sampled parses
    const FIRST_A_S = 10, SECOND_A_S = 140;   // gap 130
    const FIRST_B_S = 20, SECOND_B_S = 160;   // gap 140
    const EXPECTED_AVG_FIRST_CAST_S = (FIRST_A_S + FIRST_B_S) / 2;                 // 15
    const EXPECTED_AVG_GAP_S = ((SECOND_A_S - FIRST_A_S) + (SECOND_B_S - FIRST_B_S)) / 2; // 135
    const USERS = 2;
    const USES_A = 2, USES_B = 3;
    const summaries: ParseDefensiveSummary[] = [
      { name: 'C', cast_times_s: [FIRST_A_S, SECOND_A_S], first_cast_s: FIRST_A_S, uses: USES_A, fight_duration_s: FIGHT_DUR_S, hold_windows: [], cast_pattern: 'on_cooldown' },
      { name: 'C', cast_times_s: [FIRST_B_S, SECOND_B_S], first_cast_s: FIRST_B_S, uses: USES_B, fight_duration_s: FIGHT_DUR_S, hold_windows: [], cast_pattern: 'on_cooldown' },
    ];
    const benchmark = buildDefensiveBenchmark(summaries, CLOAK.cooldown, TOTAL_PARSES);
    expect(benchmark.sample_count).toBe(TOTAL_PARSES);   // total parses
    expect(benchmark.used_sample_count).toBe(USERS);     // users-only
    expect(benchmark.avg_first_cast_s).toBe(EXPECTED_AVG_FIRST_CAST_S);
    expect(benchmark.avg_gap_s).toBe(EXPECTED_AVG_GAP_S);
    // uses/min per parse: 2/300*60 = 0.4 and 3/300*60 = 0.6 -> mean 0.5.
    expect(benchmark.uses_per_min).toMatchObject({ avg: 0.5 });
  });

  const userSummary = (uses: number): ParseDefensiveSummary =>
    ({ name: 'C', cast_times_s: [10], first_cast_s: 10, uses, fight_duration_s: FIGHT_DUR_S, hold_windows: [], cast_pattern: 'on_cooldown' });

  it('keeps median_uses steady against a single outlier', () => {
    const TYPICAL_USES = 3;
    const OUTLIER_USES = 20;  // one parse spiking far above the rest
    const summaries = [userSummary(TYPICAL_USES), userSummary(TYPICAL_USES), userSummary(TYPICAL_USES), userSummary(OUTLIER_USES)];
    const benchmark = buildDefensiveBenchmark(summaries, CLOAK.cooldown, summaries.length);
    expect(benchmark.median_uses).toBe(TYPICAL_USES);
  });
});

describe('aggregateDefensiveBenchmarks', () => {
  it('builds per-defensive benchmarks with total vs used sample counts', () => {
    const USES_A = 1, USES_B = 3;
    const parseA: ParseDefensiveSummary[] = [{ name: 'Cloak of Shadows', cast_times_s: [10], first_cast_s: 10, uses: USES_A, fight_duration_s: FIGHT_DUR_S, hold_windows: [], cast_pattern: 'on_cooldown' }];
    const parseB: ParseDefensiveSummary[] = [{ name: 'Cloak of Shadows', cast_times_s: [20], first_cast_s: 20, uses: USES_B, fight_duration_s: FIGHT_DUR_S, hold_windows: [], cast_pattern: 'on_cooldown' }];
    const parseC: ParseDefensiveSummary[] = []; // this parse never used Cloak
    const TOTAL_PARSES = 3, USERS = 2;
    const out = aggregateDefensiveBenchmarks([parseA, parseB, parseC], [CLOAK]);
    assert.exists(out['Cloak of Shadows']);
    expect(out['Cloak of Shadows'].sample_count).toBe(TOTAL_PARSES);   // total
    assert.exists(out['Cloak of Shadows']);
    expect(out['Cloak of Shadows'].used_sample_count).toBe(USERS);     // users-only
  });
});

function reportFor(playerId: number, playerName: string, fightId: number) {
  return {
    title: 't',
    fights: [{ id: fightId, name: 'Boss', startTime: 0, endTime: 300_000, kill: true, encounterID: 1, friendlyPlayers: [] }],
    masterData: {
      actors: [{ id: playerId, name: playerName, subType: 'Rogue', server: '' }],
      enemies: [{ id: 9, name: 'Boss', gameID: 6666 }],
      abilities: [{ gameID: 700, name: 'Boss Hit', icon: 'hit.jpg' }, { gameID: CLOAK_OF_SHADOWS, name: 'Cloak of Shadows', icon: 'cloak' }],
    },
  };
}

const wclFake = {
  // getRankings returns the raw WCL envelope ({ rankings }); the transform unwraps it.
  getRankings: async () => ({
    rankings: [
      { name: 'P1', report: { code: 'r1', fightID: 1 } },
      { name: 'P2', report: { code: 'r2', fightID: 2 } },
    ],
  }),
  getReport: async (code: string) => (code === 'r1' ? reportFor(10, 'P1', 1) : reportFor(20, 'P2', 2)),
  getAllEvents: async (_code: string, _fightId: number, dataType: string) => {
    if (dataType === 'Buffs') return [applyBuff(CLOAK_OF_SHADOWS, 30), removeBuff(CLOAK_OF_SHADOWS, 35)];
    if (dataType === 'Casts') return [cast(CLOAK_OF_SHADOWS, 30)];
    return [damageTaken(700, 32, 1000, { source: 9 })]; // DamageTaken
  },
  // Raw gameData.ability map (id-keyed { id, icon, name }); the transform projects it.
  getAbilities: async (ids: number[]) =>
    Object.fromEntries(ids.map(id => [id, id === 700 ? { id, icon: 'hit', name: 'Boss Hit' } : { id, icon: 'cloak', name: 'Cloak of Shadows' }])),
};
const filesFake = {
  getRulebook: async () => ok(rulebook({ defensives: [CLOAK] })),
};

describe('DefensiveTransformService (live, in-browser)', () => {
  it('computes a clustered defensive bench from the top parses', async () => {
    TestBed.configureTestingModule({
      providers: [
        { provide: WclApiService, useValue: wclFake as unknown as WclApiService },
        { provide: DataFileApiService, useValue: filesFake as unknown as DataFileApiService },
      ],
    });
    const bench = await TestBed.inject(DefensiveTransformService).getBench('SubtletyRogue', 1);
    expect(bench.ok).toBe(true);
    if (!bench.ok) return;
    expect(bench.value.sample_count).toBe(2);
    expect(bench.value.encounter_name).toBe('Boss');
    expect(bench.value.cd_spell_ids).toEqual({ 'Cloak of Shadows': CLOAK_OF_SHADOWS });
    expect(bench.value.defensives[0]).toMatchObject({ name: 'Cloak of Shadows', spell_id: CLOAK_OF_SHADOWS });
    expect(bench.value.defensive_windows).toHaveLength(1);
    expect(bench.value.defensive_windows[0]).toMatchObject({ defensive_name: 'Cloak of Shadows', dmg_avg: 1000, ref_game_id: 6666 });
    expect(bench.value.ability_icons[700]).toEqual({ icon: 'hit', name: 'Boss Hit' });
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
    };
    TestBed.configureTestingModule({
      providers: [
        { provide: WclApiService, useValue: backfillWcl as unknown as WclApiService },
        { provide: DataFileApiService, useValue: filesFake as unknown as DataFileApiService },
      ],
    });
    const bench = await TestBed.inject(DefensiveTransformService).getBench('SubtletyRogue', 1);
    // 11 candidates, one private: the 11th backfills the skipped parse to a full 10.
    expect(bench.ok).toBe(true);
    if (bench.ok) expect(bench.value.sample_count).toBe(10);
  });

  it('reports missing when the spec has no rulebook defensives', async () => {
    TestBed.configureTestingModule({
      providers: [
        { provide: WclApiService, useValue: wclFake as unknown as WclApiService },
        { provide: DataFileApiService, useValue: { getRulebook: async () => ok({ spec: 'X', defensives: [] }) } as unknown as DataFileApiService },
      ],
    });
    const bench = await TestBed.inject(DefensiveTransformService).getBench('SubtletyRogue', 1);
    expect(bench.ok).toBe(false);
    if (!bench.ok) expect(bench.error.kind).toBe('missing');
  });

  it('surfaces a WCL failure as an error, not a silent null bench', async () => {
    const failingWcl = { ...wclFake, getRankings: async () => { throw new Error('WCL exploded'); } };
    TestBed.configureTestingModule({
      providers: [
        { provide: WclApiService, useValue: failingWcl as unknown as WclApiService },
        { provide: DataFileApiService, useValue: filesFake as unknown as DataFileApiService },
      ],
    });
    const bench = await TestBed.inject(DefensiveTransformService).getBench('SubtletyRogue', 1);
    expect(bench.ok).toBe(false);
    if (!bench.ok) expect(bench.error).toMatchObject({ kind: 'permanent', id: 'defensive.bench' });
  });
});
