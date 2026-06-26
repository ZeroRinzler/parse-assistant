import { describe, it, expect } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { WclApiService } from '../../../core/services/wcl-api';
import { DataFileApiService } from '../../../core/services/data-file-api';
import { WclEvent } from '../../../core/models/wcl.models';
import {
  DefensiveTransformService,
  defensiveSpellIds, defensivePlanMeta, buildBuffWindows, summarizeDefensiveCasts,
  findParseDefensiveWindows, clusterDefensiveWindows, buildHoldTargets, buildDefensiveBenchmark,
  aggregateDefensiveBenchmarks, bakeAbilityIcons,
  ParseDefWindow, ParseDefensiveSummary,
} from './defensive-transform.service';

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

const CLOAK = { name: 'Cloak of Shadows', spell_id: 31224, cooldown: 120, duration: 5 };

/* ----------------------------- pure functions ----------------------------- */

describe('defensiveSpellIds', () => {
  it('maps defensive names to spell ids, skipping missing ids', () => {
    expect(defensiveSpellIds([CLOAK, { name: 'NoId', spell_id: 0, cooldown: 60 }]))
      .toEqual({ 'Cloak of Shadows': 31224 });
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
    const windows = buildBuffWindows([applybuff(31224, 10), removebuff(31224, 15)], 0);
    expect(windows.get(31224)).toEqual([[10, 15]]);
  });
  it('leaves an unmatched apply open (null end)', () => {
    const windows = buildBuffWindows([applybuff(31224, 10)], 0);
    expect(windows.get(31224)).toEqual([[10, null]]);
  });
});

describe('summarizeDefensiveCasts', () => {
  it('builds one use per buff window and detects holds > 8s past cooldown', () => {
    const windows = buildBuffWindows([applybuff(31224, 10), removebuff(31224, 15), applybuff(31224, 200), removebuff(31224, 205)], 0);
    const summaries = summarizeDefensiveCasts([CLOAK], windows, [], 0, 300);
    expect(summaries).toHaveLength(1);
    // second cast at 200, expected = 10 + 120 = 130, hold = 70 > 8.
    expect(summaries[0]).toMatchObject({ name: 'Cloak of Shadows', uses: 2, first_cast_s: 10, cast_pattern: 'hold' });
    expect(summaries[0].hold_windows).toEqual([{ cast_index: 1, actual_s: 200 }]);
  });

  it('falls back to explicit casts when no buff windows exist', () => {
    const summaries = summarizeDefensiveCasts([CLOAK], new Map(), [cast(31224, 12)], 0, 300);
    expect(summaries[0]).toMatchObject({ uses: 1, first_cast_s: 12, cast_pattern: 'on_cooldown' });
  });
});

describe('findParseDefensiveWindows', () => {
  it('slices damage taken by the buff span and picks the dominant enemy', () => {
    const windows = buildBuffWindows([applybuff(31224, 10), removebuff(31224, 15)], 0);
    const result = findParseDefensiveWindows(
      [dtaken(700, 12, 500, 9), dtaken(701, 13, 200, 8), dtaken(700, 100, 999, 9)],
      0, windows, [CLOAK], new Map([[9, 6666], [8, 5555]]),
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ defensive_name: 'Cloak of Shadows', spell_id: 31224, window_damage: 700, ref_game_id: 6666 });
    expect(result[0].ability_breakdown[0]).toMatchObject({ spell_id: 700, damage: 500 });
  });
});

describe('clusterDefensiveWindows', () => {
  const window = (timeS: number): ParseDefWindow => ({
    time_s: timeS, window_length_s: 5, window_damage: 700, defensive_name: 'Cloak of Shadows', spell_id: 31224,
    ref_game_id: 6666, ability_breakdown: [{ spell_id: 700, damage: 500 }],
  });

  it('emits a per-defensive cluster present in enough parses, with majority ref enemy', () => {
    const out = clusterDefensiveWindows([window(10), window(11)], 2);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ time_s: 10.5, defensive_name: 'Cloak of Shadows', spell_id: 31224, dmg_avg: 700, ref_game_id: 6666 });
    expect(out[0].common_defensives).toEqual(['Cloak of Shadows']);
    expect(out[0].ability_breakdown[0]).toMatchObject({ spell_id: 700, avg_damage: 500, count: 2 });
  });

  it('drops a cluster below the min-sample fraction', () => {
    expect(clusterDefensiveWindows([window(10)], 10)).toHaveLength(0);
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
    expect(out.topDefensivesSummary).toEqual([{ spell_id: 31224, avg_uses: 2, min_uses: 1, max_uses: 3 }]);
  });
});

describe('bakeAbilityIcons', () => {
  it('bakes defensive spells + window abilities, dropping .jpg', () => {
    const windows = [{ ability_breakdown: [{ spell_id: 700 }] }] as never;
    const icons = bakeAbilityIcons(
      [CLOAK], windows,
      new Map([[31224, { name: 'Cloak of Shadows', icon: 'spell.jpg' }], [700, { name: 'Hit', icon: 'hit' }]]),
    );
    expect(icons).toEqual({ 31224: { icon: 'spell', name: 'Cloak of Shadows' }, 700: { icon: 'hit', name: 'Hit' } });
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
      abilities: [{ gameID: 700, name: 'Boss Hit', icon: 'hit.jpg' }, { gameID: 31224, name: 'Cloak of Shadows', icon: 'cloak' }],
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
    if (dataType === 'Buffs') return [applybuff(31224, 30), removebuff(31224, 35)];
    if (dataType === 'Casts') return [cast(31224, 30)];
    return [dtaken(700, 32, 1000, 9)]; // DamageTaken
  },
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
    const bench = await TestBed.inject(DefensiveTransformService).getDefensiveBench('SubtletyRogue', 1);
    expect(bench).not.toBeNull();
    expect(bench!.sample_count).toBe(2);
    expect(bench!.encounter_name).toBe('Boss');
    expect(bench!.cd_spell_ids).toEqual({ 'Cloak of Shadows': 31224 });
    expect(bench!.defensives[0]).toMatchObject({ name: 'Cloak of Shadows', spell_id: 31224 });
    expect(bench!.defensive_windows).toHaveLength(1);
    expect(bench!.defensive_windows[0]).toMatchObject({ defensive_name: 'Cloak of Shadows', dmg_avg: 1000, ref_game_id: 6666 });
    expect(bench!.top_defensives_summary).toEqual([{ spell_id: 31224, avg_uses: 1, min_uses: 1, max_uses: 1 }]);
    expect(bench!.ability_icons[700]).toEqual({ icon: 'hit', name: 'Boss Hit' });
  });

  it('returns null when the spec has no rulebook defensives', async () => {
    TestBed.configureTestingModule({
      providers: [
        { provide: WclApiService, useValue: wclFake as unknown as WclApiService },
        { provide: DataFileApiService, useValue: { getRulebook: async () => ({ spec: 'X', defensives: [] }) } as unknown as DataFileApiService },
      ],
    });
    expect(await TestBed.inject(DefensiveTransformService).getDefensiveBench('SubtletyRogue', 1)).toBeNull();
  });
});
