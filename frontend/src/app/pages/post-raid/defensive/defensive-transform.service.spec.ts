import { describe, it, expect } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { WclApiService } from '../../../core/services/wcl-api';
import { DataFileApiService } from '../../../core/services/data-file-api';
import { WclEvent } from '../../../core/models/wcl.models';
import {
  DefensiveTransformService,
  defensiveSpellIds, defensivePlanMeta, buildBuffWindows, summarizeDefensiveCasts,
  findParseDefensiveWindows, clusterDefensiveWindows, buildHoldTargets, buildDefensiveBenchmark,
  aggregateDefensiveBenchmarks,
  windowDamageBreakdown, clusterDamageStats, clusterAbilityBreakdown,
  ParseDefWindow, ParseDefensiveSummary,
} from './defensive-transform.service';
import { CLOAK_OF_SHADOWS } from '../../../../testing/spell-ids';

// Enemy-side identifiers for the damage-taken fixtures (not player abilities, so local).
const BOSS_HIT = 700;       // an enemy ability id the player takes damage from
const ADD_HIT = 701;
const BOSS_ACTOR = 9;       // report actor id of the boss
const ADD_ACTOR = 8;        // report actor id of an add
const BOSS_GAME_ID = 6666;  // stable gameID the boss actor maps to
const ADD_GAME_ID = 5555;   // stable gameID the add actor maps to

function applybuff(spellId: number, atS: number): WclEvent {
  return { type: 'applybuff', timestamp: atS * 1000, abilityGameID: spellId };
}
function removebuff(spellId: number, atS: number): WclEvent {
  return { type: 'removebuff', timestamp: atS * 1000, abilityGameID: spellId };
}
function cast(spellId: number, atS: number): WclEvent {
  return { type: 'cast', timestamp: atS * 1000, abilityGameID: spellId };
}
function dtaken(spellId: number, atS: number, amount: number, sourceId?: number): WclEvent {
  return { type: 'damage', timestamp: atS * 1000, abilityGameID: spellId, amount, sourceID: sourceId };
}

const CLOAK = { name: 'Cloak of Shadows', spell_id: CLOAK_OF_SHADOWS, cooldown: 120, duration: 5 };

/* ----------------------------- pure functions ----------------------------- */

describe('defensiveSpellIds', () => {
  it('maps defensive names to spell ids, skipping missing ids', () => {
    expect(defensiveSpellIds([CLOAK, { name: 'NoId', spell_id: 0, cooldown: 60 }]))
      .toEqual({ 'Cloak of Shadows': CLOAK_OF_SHADOWS });
  });
});

describe('defensivePlanMeta', () => {
  it('carries metadata with nullable defaults', () => {
    expect(defensivePlanMeta([{ name: 'Evasion', spell_id: 5277, cooldown: 120 }]))
      .toEqual([{ name: 'Evasion', spell_id: 5277, cooldown: 120, duration: null, usage_rule: null, talent_gated: false }]);
  });
});

describe('buildBuffWindows', () => {
  it('pairs apply with the latest open remove', () => {
    const windows = buildBuffWindows([applybuff(CLOAK_OF_SHADOWS, 10), removebuff(CLOAK_OF_SHADOWS, 15)], 0);
    expect(windows.get(CLOAK_OF_SHADOWS)).toEqual([[10, 15]]);
  });
  it('leaves an unmatched apply open (null end)', () => {
    const windows = buildBuffWindows([applybuff(CLOAK_OF_SHADOWS, 10)], 0);
    expect(windows.get(CLOAK_OF_SHADOWS)).toEqual([[10, null]]);
  });
});

describe('summarizeDefensiveCasts', () => {
  it('builds one use per buff window and detects holds > 8s past cooldown', () => {
    const windows = buildBuffWindows([applybuff(CLOAK_OF_SHADOWS, 10), removebuff(CLOAK_OF_SHADOWS, 15), applybuff(CLOAK_OF_SHADOWS, 200), removebuff(CLOAK_OF_SHADOWS, 205)], 0);
    const summaries = summarizeDefensiveCasts([CLOAK], windows, [], 0, 300);
    expect(summaries).toHaveLength(1);
    // second cast at 200, expected = 10 + 120 = 130, hold = 70 > 8.
    expect(summaries[0]).toMatchObject({ name: 'Cloak of Shadows', uses: 2, first_cast_s: 10, cast_pattern: 'hold' });
    expect(summaries[0].hold_windows).toEqual([{ cast_index: 1, actual_s: 200 }]);
  });

  it('falls back to explicit casts when no buff windows exist', () => {
    const summaries = summarizeDefensiveCasts([CLOAK], new Map(), [cast(CLOAK_OF_SHADOWS, 12)], 0, 300);
    expect(summaries[0]).toMatchObject({ uses: 1, first_cast_s: 12, cast_pattern: 'on_cooldown' });
  });
});

describe('findParseDefensiveWindows', () => {
  it('slices damage taken by the buff span and picks the dominant enemy', () => {
    const windows = buildBuffWindows([applybuff(CLOAK_OF_SHADOWS, 10), removebuff(CLOAK_OF_SHADOWS, 15)], 0);
    const result = findParseDefensiveWindows(
      [dtaken(BOSS_HIT, 12, 500, BOSS_ACTOR), dtaken(ADD_HIT, 13, 200, ADD_ACTOR), dtaken(BOSS_HIT, 100, 999, BOSS_ACTOR)],
      0, 300, windows, [CLOAK], new Map([[BOSS_ACTOR, BOSS_GAME_ID], [ADD_ACTOR, ADD_GAME_ID]]),
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ defensive_name: 'Cloak of Shadows', spell_id: CLOAK_OF_SHADOWS, window_damage: 700, ref_game_id: BOSS_GAME_ID });
    expect(result[0].ability_breakdown[0]).toMatchObject({ spell_id: BOSS_HIT, damage: 500 });
  });

  it('runs an open buff to fight end (no rulebook duration)', () => {
    const windows = buildBuffWindows([applybuff(CLOAK_OF_SHADOWS, 10)], 0); // no remove
    const result = findParseDefensiveWindows(
      [dtaken(BOSS_HIT, 50, 400, BOSS_ACTOR)], 0, 300, windows, [CLOAK], new Map([[BOSS_ACTOR, BOSS_GAME_ID]]),
    );
    expect(result[0].window_length_s).toBe(290); // 10 -> 300 (fight end), not 10 + duration
    expect(result[0].window_damage).toBe(400);
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
});

describe('clusterDamageStats', () => {
  it('reports avg/stddev/min/max over the window damages, rounded', () => {
    const LOW = 700;
    const HIGH = 900;
    expect(clusterDamageStats([LOW, HIGH])).toEqual({ dmg_avg: 800, dmg_stddev: Math.round(Math.sqrt(20000)), dmg_min: LOW, dmg_max: HIGH });
  });
});

describe('clusterAbilityBreakdown', () => {
  const member = (abilities: { spell_id: number; damage: number }[]): ParseDefWindow => ({
    time_s: 10, window_length_s: 5, window_damage: 700, pct_of_total: 0.2, parse_index: 0,
    defensive_name: 'Cloak of Shadows', spell_id: CLOAK_OF_SHADOWS, ref_game_id: BOSS_GAME_ID, ability_breakdown: abilities,
  });

  it('keeps an ability present in a majority of members with avg/min/max', () => {
    const out = clusterAbilityBreakdown([
      member([{ spell_id: BOSS_HIT, damage: 400 }]), member([{ spell_id: BOSS_HIT, damage: 600 }]),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ spell_id: BOSS_HIT, avg_damage: 500, min_damage: 400, max_damage: 600, count: 2 });
  });

  it('drops an ability below the member-majority share (boundary)', () => {
    // 1 of 3 members carries ADD_HIT -> 0.33 < 0.5 majority -> dropped.
    const out = clusterAbilityBreakdown([
      member([{ spell_id: BOSS_HIT, damage: 500 }]), member([{ spell_id: BOSS_HIT, damage: 500 }]),
      member([{ spell_id: ADD_HIT, damage: 500 }]),
    ]);
    expect(out.map(ability => ability.spell_id)).toEqual([BOSS_HIT]);
  });
});

describe('clusterDefensiveWindows', () => {
  const window = (timeS: number, parseIndex: number, pct = 0.2): ParseDefWindow => ({
    time_s: timeS, window_length_s: 5, window_damage: 700, pct_of_total: pct, parse_index: parseIndex,
    defensive_name: 'Cloak of Shadows', spell_id: CLOAK_OF_SHADOWS, ref_game_id: BOSS_GAME_ID, ability_breakdown: [{ spell_id: BOSS_HIT, damage: 500 }],
  });

  it('emits a per-defensive cluster present in a majority of distinct parses, with majority ref enemy', () => {
    const out = clusterDefensiveWindows([window(10, 0), window(11, 1)], 2);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ time_s: 10.5, defensive_name: 'Cloak of Shadows', spell_id: CLOAK_OF_SHADOWS, dmg_avg: 700, ref_game_id: BOSS_GAME_ID });
    expect(out[0].common_defensives).toEqual(['Cloak of Shadows']);
    expect(out[0].ability_breakdown[0]).toMatchObject({ spell_id: BOSS_HIT, avg_damage: 500, count: 2 });
  });

  it('keeps a window in exactly half the parses, drops one just below (majority boundary)', () => {
    const five = [window(10, 0), window(11, 1), window(10, 2), window(12, 3), window(11, 4)];
    expect(clusterDefensiveWindows(five, 10)).toHaveLength(1);
    const four = [window(10, 0), window(11, 1), window(10, 2), window(12, 3)];
    expect(clusterDefensiveWindows(four, 10)).toHaveLength(0);
  });

  it('drops a consensus window whose median damage share is below the gate', () => {
    const low = [window(10, 0, 0.01), window(11, 1, 0.01)];
    expect(clusterDefensiveWindows(low, 2)).toHaveLength(0);
  });
});

describe('buildHoldTargets', () => {
  it('surfaces a cast index held by >= 40% of samples', () => {
    const summaries: ParseDefensiveSummary[] = [
      { name: 'C', cast_times_s: [], first_cast_s: 0, uses: 2, fight_duration_s: 300, hold_windows: [{ cast_index: 1, actual_s: 100 }], cast_pattern: 'hold' },
      { name: 'C', cast_times_s: [], first_cast_s: 0, uses: 2, fight_duration_s: 300, hold_windows: [{ cast_index: 1, actual_s: 110 }], cast_pattern: 'hold' },
    ];
    const targets = buildHoldTargets(summaries);
    expect(targets['1']).toMatchObject({ target_s: 105, count: 2, total_samples: 2 });
  });
});

describe('buildDefensiveBenchmark', () => {
  it('derives first-cast / gap / uses-per-min from a defensive\'s parse summaries', () => {
    const summaries: ParseDefensiveSummary[] = [
      { name: 'C', cast_times_s: [10, 140], first_cast_s: 10, uses: 2, fight_duration_s: 300, hold_windows: [], cast_pattern: 'on_cooldown' },
      { name: 'C', cast_times_s: [20, 160], first_cast_s: 20, uses: 2, fight_duration_s: 300, hold_windows: [], cast_pattern: 'on_cooldown' },
    ];
    const benchmark = buildDefensiveBenchmark(summaries);
    expect(benchmark.sample_count).toBe(2);
    expect(benchmark.avg_first_cast_s).toBe(15);
    expect(benchmark.avg_gap_s).toBe(135); // gaps 130 and 140
    expect(benchmark.avg_uses).toBe(2);
    expect(benchmark.uses_per_min.avg).toBeGreaterThan(0);
  });
});

describe('aggregateDefensiveBenchmarks', () => {
  it('builds per-defensive benchmarks + the top-defensives summary', () => {
    const parseA: ParseDefensiveSummary[] = [{ name: 'Cloak of Shadows', cast_times_s: [10], first_cast_s: 10, uses: 1, fight_duration_s: 300, hold_windows: [], cast_pattern: 'on_cooldown' }];
    const parseB: ParseDefensiveSummary[] = [{ name: 'Cloak of Shadows', cast_times_s: [20], first_cast_s: 20, uses: 3, fight_duration_s: 300, hold_windows: [], cast_pattern: 'on_cooldown' }];
    const out = aggregateDefensiveBenchmarks([parseA, parseB], [CLOAK]);
    expect(out.perDefensiveBenchmarks['Cloak of Shadows'].sample_count).toBe(2);
    expect(out.topDefensivesSummary).toEqual([{ spell_id: CLOAK_OF_SHADOWS, avg_uses: 2, min_uses: 1, max_uses: 3 }]);
  });
});

/* ----------------------------- service (end to end, fake client) ----------------------------- */

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
  getRankings: async () => [
    { name: 'P1', report: { code: 'r1', fightID: 1 } },
    { name: 'P2', report: { code: 'r2', fightID: 2 } },
  ],
  getReport: async (code: string) => (code === 'r1' ? reportFor(10, 'P1', 1) : reportFor(20, 'P2', 2)),
  getAllEvents: async (_code: string, _fightId: number, dataType: string) => {
    if (dataType === 'Buffs') return [applybuff(CLOAK_OF_SHADOWS, 30), removebuff(CLOAK_OF_SHADOWS, 35)];
    if (dataType === 'Casts') return [cast(CLOAK_OF_SHADOWS, 30)];
    return [dtaken(700, 32, 1000, 9)]; // DamageTaken
  },
  // Resolves a real icon + name for every requested spell id (gameData.ability).
  getAbilities: async (ids: number[]) =>
    Object.fromEntries(ids.map(id => [id, id === 700 ? { icon: 'hit', name: 'Boss Hit' } : { icon: 'cloak', name: 'Cloak of Shadows' }])),
};
const filesFake = {
  getRulebook: async () => ({ spec: 'SubtletyRogue', major_cooldowns: [], defensives: [CLOAK] }),
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
    expect(bench).not.toBeNull();
    expect(bench!.sample_count).toBe(2);
    expect(bench!.encounter_name).toBe('Boss');
    expect(bench!.cd_spell_ids).toEqual({ 'Cloak of Shadows': CLOAK_OF_SHADOWS });
    expect(bench!.defensives[0]).toMatchObject({ name: 'Cloak of Shadows', spell_id: CLOAK_OF_SHADOWS });
    expect(bench!.defensive_windows).toHaveLength(1);
    expect(bench!.defensive_windows[0]).toMatchObject({ defensive_name: 'Cloak of Shadows', dmg_avg: 1000, ref_game_id: 6666 });
    expect(bench!.top_defensives_summary).toEqual([{ spell_id: CLOAK_OF_SHADOWS, avg_uses: 1, min_uses: 1, max_uses: 1 }]);
    expect(bench!.ability_icons[700]).toEqual({ icon: 'hit', name: 'Boss Hit' });
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
    };
    TestBed.configureTestingModule({
      providers: [
        { provide: WclApiService, useValue: backfillWcl as unknown as WclApiService },
        { provide: DataFileApiService, useValue: filesFake as unknown as DataFileApiService },
      ],
    });
    const bench = await TestBed.inject(DefensiveTransformService).getBench('SubtletyRogue', 1);
    // 11 candidates, one private: the 11th backfills the skipped parse to a full 10.
    expect(bench!.sample_count).toBe(10);
  });

  it('returns null when the spec has no rulebook defensives', async () => {
    TestBed.configureTestingModule({
      providers: [
        { provide: WclApiService, useValue: wclFake as unknown as WclApiService },
        { provide: DataFileApiService, useValue: { getRulebook: async () => ({ spec: 'X', defensives: [] }) } as unknown as DataFileApiService },
      ],
    });
    expect(await TestBed.inject(DefensiveTransformService).getBench('SubtletyRogue', 1)).toBeNull();
  });
});
