import { describe, it, expect } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { WclApiService } from '../../../core/services/wcl-api';
import { WclEvent } from '../../../core/models/wcl.models';
import { BurstWindow, PlayerBurstWindow, PlayerDefensive } from '../../../core/models/analysis.models';
import { PerDefensiveBenchmark } from '../../../core/models/encounter.models';
import { DEFENSIVE_DATA_SOURCE, DefensiveBench, DefensiveDataSource } from './defensive-data-source';
import {
  DefensiveFeatureService,
  analyzeDefensives, analyzeDefensiveFindings, computePlayerDefensiveWindows,
  defensiveWindowStatus, defensiveMapAnchor, buildDefensiveWindows, buildDefensivePlanRows,
  playerCoveredWindow, playerUsefulTiming, windowMissFindings,
} from './defensive.service';
import { CLOAK_OF_SHADOWS } from '../../../../testing/spell-ids';

function applybuff(spellId: number, atS: number): WclEvent {
  return { type: 'applybuff', timestamp: atS * 1000, abilityGameID: spellId };
}
function removebuff(spellId: number, atS: number): WclEvent {
  return { type: 'removebuff', timestamp: atS * 1000, abilityGameID: spellId };
}
function dtaken(spellId: number, atS: number, amount: number): WclEvent {
  return { type: 'damage', timestamp: atS * 1000, abilityGameID: spellId, amount };
}

const CLOAK_META = { name: 'Cloak of Shadows', spell_id: CLOAK_OF_SHADOWS, cooldown: 120, duration: 5, usage_rule: 'Use on big hits', talent_gated: false };

/* ----------------------------- player defensives ----------------------------- */

describe('analyzeDefensives', () => {
  it('builds buff-window-centric uses with damage taken during each window', () => {
    const out = analyzeDefensives(
      [CLOAK_META],
      [], [applybuff(CLOAK_OF_SHADOWS, 10), removebuff(CLOAK_OF_SHADOWS, 15)], [dtaken(700, 12, 500)],
      0, 300_000,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ name: 'Cloak of Shadows', uses: 1, cast_times_s: [10] });
    expect(out[0].windows[0]).toMatchObject({ start_s: 10, end_s: 15, dmg_during: 500 });
  });

  it('falls back to a point usage (no rulebook-duration window) when no buffs exist', () => {
    const out = analyzeDefensives(
      [CLOAK_META],
      [{ type: 'cast', timestamp: 20_000, abilityGameID: CLOAK_OF_SHADOWS }], [], [dtaken(700, 21, 300)],
      0, 300_000,
    );
    expect(out[0]).toMatchObject({ uses: 1, cast_times_s: [20] });
    expect(out[0].windows[0]).toMatchObject({ start_s: 20, end_s: 20, dmg_during: 0 });
  });

  it('runs an open buff to fight end, not a rulebook duration', () => {
    const out = analyzeDefensives(
      [CLOAK_META], [], [applybuff(CLOAK_OF_SHADOWS, 10)], [dtaken(700, 50, 400)], 0, 300_000,
    );
    expect(out[0].windows[0]).toMatchObject({ start_s: 10, end_s: 300, dmg_during: 400 });
  });
});

describe('analyzeDefensiveFindings', () => {
  const bench: Record<string, PerDefensiveBenchmark> = {
    'Cloak of Shadows': {
      sample_count: 10, avg_first_cast_s: 10, stddev_first_cast_s: 2,
      avg_gap_s: 60, stddev_gap_s: 5, hold_targets: {},
      avg_uses: 2, avg_uses_per_min: 0.4, uses_per_min: { avg: 0.4, stddev: 0.05, min: 0.3, max: 0.5 },
      majority_hold: false,
    },
  };

  it('flags a never-used defensive as a critical lost cooldown', () => {
    const findings = analyzeDefensiveFindings(
      [{ name: 'Cloak of Shadows', spell_id: CLOAK_OF_SHADOWS, cooldown: 120, uses: 0, cast_times_s: [], windows: [] }],
      bench, 300,
    );
    expect(findings[0]).toMatchObject({ severity: 'critical', category: 'lost_cooldown', cd_name: 'Cloak of Shadows' });
  });

  it('emits a success when usage matches and there are no issues', () => {
    const findings = analyzeDefensiveFindings(
      [{ name: 'Cloak of Shadows', spell_id: CLOAK_OF_SHADOWS, cooldown: 120, uses: 2, cast_times_s: [10, 70], windows: [] }],
      bench, 300,
    );
    expect(findings.some(f => f.severity === 'success' && f.cd_name === 'Cloak of Shadows')).toBe(true);
  });

  it('flags a late first use as a warning', () => {
    const findings = analyzeDefensiveFindings(
      [{ name: 'Cloak of Shadows', spell_id: CLOAK_OF_SHADOWS, cooldown: 120, uses: 1, cast_times_s: [40], windows: [] }],
      bench, 300,
    );
    expect(findings.some(f => f.severity === 'warning' && f.category === 'cooldown_delay')).toBe(true);
  });

  it('skips a talent-gated defensive that was never used', () => {
    const findings = analyzeDefensiveFindings(
      [{ name: 'Cloak of Shadows', spell_id: CLOAK_OF_SHADOWS, cooldown: 120, uses: 0, cast_times_s: [], windows: [], talent_gated: true }],
      bench, 300,
    );
    expect(findings).toEqual([]);
  });
});

describe('computePlayerDefensiveWindows', () => {
  it('sums player damage taken inside each top defensive window (half-open)', () => {
    const top: BurstWindow[] = [
      { time_s: 10, window_length_s: 5, dmg_avg: 0, dmg_min: 0, dmg_max: 0, dmg_stddev: 0, common_cds: [], ability_breakdown: [] },
    ];
    const out = computePlayerDefensiveWindows(top, [dtaken(700, 12, 400), dtaken(701, 14, 100), dtaken(700, 15, 999)], 0);
    expect(out[0].window_damage).toBe(500); // event at exactly 15 (== end) excluded
    expect(out[0].ability_breakdown![0]).toMatchObject({ spell_id: 700, damage: 400 });
  });
});

/* ----------------------------- defensive windows view ----------------------------- */

describe('defensiveWindowStatus', () => {
  // topAvg 1000, topMax 1200, stddev 100. Lower damage is better; covering the window is required.
  it.each([
    { name: 'not reached -> muted', player: 950 as number | null, notReached: true, covered: true, useful: false, status: 'muted', icon: 'schedule' },
    { name: 'missing -> muted', player: null, notReached: false, covered: true, useful: false, status: 'muted', icon: 'help_outline' },
    { name: 'not covered -> bad', player: 900, notReached: false, covered: false, useful: false, status: 'bad', icon: 'error' },
    { name: 'covered + useful timing -> good', player: 1400, notReached: false, covered: true, useful: true, status: 'good', icon: 'check_circle' },
    { name: 'covered, far above max -> warn', player: 1400, notReached: false, covered: true, useful: false, status: 'warn', icon: 'warning_amber' },
    { name: 'covered, above avg band -> warn', player: 1150, notReached: false, covered: true, useful: false, status: 'warn', icon: 'warning_amber' },
    { name: 'covered, within range -> good', player: 1000, notReached: false, covered: true, useful: false, status: 'good', icon: 'check_circle' },
  ])('$name', ({ player, notReached, covered, useful, status, icon }) => {
    expect(defensiveWindowStatus(player, 1000, 1200, 100, notReached, covered, useful)).toEqual({ status, icon });
  });
});

describe('playerCoveredWindow', () => {
  const window = { time_s: 30, window_length_s: 5 } as BurstWindow;
  const withSpans = (spans: { start_s: number; end_s: number; dmg_during: number }[]): PlayerDefensive =>
    ({ name: 'Cloak of Shadows', spell_id: CLOAK_OF_SHADOWS, cooldown: 120, uses: spans.length, windows: spans });

  it('is true when a player span overlaps the window plus slack', () => {
    expect(playerCoveredWindow(window, withSpans([{ start_s: 33, end_s: 38, dmg_during: 0 }]))).toBe(true);
  });

  it('covers a span reaching the slack edge, not one just short of it', () => {
    // window [30,35], slack 3 -> covers [27,38]; a span ending at 27 reaches the edge.
    expect(playerCoveredWindow(window, withSpans([{ start_s: 10, end_s: 27, dmg_during: 0 }]))).toBe(true);
    expect(playerCoveredWindow(window, withSpans([{ start_s: 10, end_s: 26, dmg_during: 0 }]))).toBe(false);
  });

  it('is false with no player defensive', () => {
    expect(playerCoveredWindow(window, undefined)).toBe(false);
  });
});

describe('playerUsefulTiming', () => {
  const window = { time_s: 30, window_length_s: 5, dmg_min: 800 } as BurstWindow;
  const withSpans = (spans: { start_s: number; end_s: number; dmg_during: number }[]): PlayerDefensive =>
    ({ name: 'Cloak of Shadows', spell_id: CLOAK_OF_SHADOWS, cooldown: 120, uses: spans.length, windows: spans });

  it('is true when a covering span mitigated at least the window minimum', () => {
    expect(playerUsefulTiming(window, withSpans([{ start_s: 31, end_s: 36, dmg_during: 800 }]))).toBe(true);
  });

  it('is false when the covering span mitigated just under the minimum (boundary)', () => {
    expect(playerUsefulTiming(window, withSpans([{ start_s: 31, end_s: 36, dmg_during: 799 }]))).toBe(false);
  });

  it('is false when the big mitigation is not near the window', () => {
    expect(playerUsefulTiming(window, withSpans([{ start_s: 100, end_s: 105, dmg_during: 5000 }]))).toBe(false);
  });
});

describe('defensiveMapAnchor', () => {
  const abilities = { [CLOAK_OF_SHADOWS]: { icon: 'cloak', name: 'Cloak of Shadows' } };
  it('carries seek time, label, defensive spell and the dominant enemy game id', () => {
    const window = { time_s: 30, window_length_s: 5, defensive_name: 'Cloak of Shadows', spell_id: CLOAK_OF_SHADOWS, ref_game_id: 6666 } as BurstWindow;
    expect(defensiveMapAnchor(window, abilities)).toEqual({
      timeS: 30, label: 'Cloak of Shadows', spells: [{ id: CLOAK_OF_SHADOWS, icon: 'cloak', name: 'Cloak of Shadows' }], refGameId: 6666,
    });
  });

  it('falls back to a generic label and null ref when absent', () => {
    const window = { time_s: 5, window_length_s: 5 } as BurstWindow;
    expect(defensiveMapAnchor(window, {})).toEqual({ timeS: 5, label: 'Defensive', spells: [], refGameId: null });
  });
});

describe('buildDefensiveWindows', () => {
  const window: BurstWindow = {
    time_s: 30, window_length_s: 5, dmg_avg: 1000, dmg_min: 800, dmg_max: 1200, dmg_stddev: 100,
    defensive_name: 'Cloak of Shadows', spell_id: CLOAK_OF_SHADOWS, ref_game_id: 6666, common_cds: ['Cloak of Shadows'],
    ability_breakdown: [{ spell_id: 700, avg_damage: 600, min_damage: 400, max_damage: 800, count: 5 }],
  };
  const abilities = { [CLOAK_OF_SHADOWS]: { icon: 'cloak', name: 'Cloak of Shadows' }, 700: { icon: 'hit', name: 'Boss Hit' } };

  it('pairs each window with player damage taken at the same index', () => {
    const player: PlayerBurstWindow[] = [{ time_s: 30, window_damage: 1150, ability_breakdown: [{ spell_id: 700, damage: 700 }] }];
    // Covered the window (span 30-35), mitigated under dmg_min, took above the avg band -> warn.
    const playerDef: PlayerDefensive[] = [{ name: 'Cloak of Shadows', spell_id: CLOAK_OF_SHADOWS, cooldown: 120, uses: 1, windows: [{ start_s: 30, end_s: 35, dmg_during: 700 }] }];
    const { windows, anchors } = buildDefensiveWindows([window], player, playerDef, 300, abilities);
    expect(windows[0].overview.playerPct).toBe(1150);
    expect(windows[0].status).toBe('warn');
    expect(windows[0].spells).toEqual([{ id: CLOAK_OF_SHADOWS, icon: 'cloak', name: 'Cloak of Shadows' }]);
    expect(windows[0].detailRows[0]).toMatchObject({ spellId: 700, label: 'Boss Hit', icon: 'hit', playerPct: 700, topAvg: 600 });
    expect(anchors[0]).toEqual({ timeS: 30, label: 'Cloak of Shadows', spells: [{ id: CLOAK_OF_SHADOWS, icon: 'cloak', name: 'Cloak of Shadows' }], refGameId: 6666 });
  });

  it('marks an uncovered window bad', () => {
    const player: PlayerBurstWindow[] = [{ time_s: 30, window_damage: 900, ability_breakdown: [] }];
    const { windows } = buildDefensiveWindows([window], player, [], 300, abilities);
    expect(windows[0].status).toBe('bad');
  });

  it('mutes and drops player data for a window the fight never reached', () => {
    const { windows } = buildDefensiveWindows([window], [], [], 5, abilities);
    expect(windows[0].status).toBe('muted');
    expect(windows[0].overview.playerPct).toBeNull();
  });
});

describe('windowMissFindings', () => {
  const missWindow: BurstWindow = {
    time_s: 30, window_length_s: 5, dmg_avg: 1000, dmg_min: 800, dmg_max: 1200, dmg_stddev: 100,
    defensive_name: 'Cloak of Shadows', spell_id: CLOAK_OF_SHADOWS, common_cds: ['Cloak of Shadows'], ability_breakdown: [],
  };
  const covering: PlayerDefensive[] = [{ name: 'Cloak of Shadows', spell_id: CLOAK_OF_SHADOWS, cooldown: 120, uses: 1, windows: [{ start_s: 30, end_s: 35, dmg_during: 900 }] }];

  it('warns for an uncovered consensus window', () => {
    const out = windowMissFindings([missWindow], [], 300);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ severity: 'warning', category: 'defensive_window', cd_name: 'Cloak of Shadows' });
  });

  it('does not warn when the player covered the window', () => {
    expect(windowMissFindings([missWindow], covering, 300)).toEqual([]);
  });

  it('does not warn for a window the fight never reached', () => {
    expect(windowMissFindings([missWindow], [], 5)).toEqual([]);
  });
});

/* ----------------------------- pre-fight plan ----------------------------- */

describe('buildDefensivePlanRows', () => {
  function benchWith(overrides: Partial<DefensiveBench>): DefensiveBench {
    return {
      spec: 'SubtletyRogue', encounter_id: 1, encounter_name: 'Boss', sample_count: 5,
      per_defensive_benchmarks: {}, defensive_windows: [], top_defensives_summary: [],
      defensives: [], cd_spell_ids: {}, ability_icons: {},
      ...overrides,
    };
  }

  it('returns [] when the bench is null or has no defensives', () => {
    expect(buildDefensivePlanRows(null)).toEqual([]);
    expect(buildDefensivePlanRows(benchWith({}))).toEqual([]);
  });

  it('builds plan rows with window times and avg uses', () => {
    const bench = benchWith({
      defensives: [{ name: 'Cloak of Shadows', spell_id: CLOAK_OF_SHADOWS, cooldown: 120, duration: 5, usage_rule: 'Use it', talent_gated: false }],
      ability_icons: { [CLOAK_OF_SHADOWS]: { icon: 'cloak', name: 'Cloak of Shadows' } },
      per_defensive_benchmarks: {
        'Cloak of Shadows': {
          sample_count: 5, avg_first_cast_s: 12, stddev_first_cast_s: 2, avg_gap_s: null, stddev_gap_s: null,
          hold_targets: {}, avg_uses: 2, avg_uses_per_min: 0.4, uses_per_min: { avg: 0.4, stddev: 0.05, min: 0.3, max: 0.5 },
          majority_hold: false,
        },
      },
      defensive_windows: [{ time_s: 30, window_length_s: 5, dmg_avg: 0, dmg_min: 0, dmg_max: 0, dmg_stddev: 0, defensive_name: 'Cloak of Shadows', common_cds: ['Cloak of Shadows'], ability_breakdown: [] }],
    });
    const rows = buildDefensivePlanRows(bench);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'Cloak of Shadows', spellId: CLOAK_OF_SHADOWS, icon: 'cloak', uses: 2, firstCastS: 12, windowsS: [30], rule: 'Use it' });
  });
});

/* ----------------------------- feature service (dual mode) ---------------------------- */

function fullBench(): DefensiveBench {
  return {
    spec: 'SubtletyRogue', encounter_id: 1, encounter_name: 'Boss', sample_count: 5,
    per_defensive_benchmarks: {
      'Cloak of Shadows': {
        sample_count: 5, avg_first_cast_s: 10, stddev_first_cast_s: 2, avg_gap_s: 60, stddev_gap_s: 5,
        hold_targets: {}, avg_uses: 2, avg_uses_per_min: 0.4, uses_per_min: { avg: 0.4, stddev: 0.05, min: 0.3, max: 0.5 },
        majority_hold: false,
      },
    },
    defensive_windows: [{
      time_s: 30, window_length_s: 5, dmg_avg: 1000, dmg_min: 800, dmg_max: 1200, dmg_stddev: 100,
      defensive_name: 'Cloak of Shadows', spell_id: CLOAK_OF_SHADOWS, ref_game_id: 6666, common_cds: ['Cloak of Shadows'],
      ability_breakdown: [{ spell_id: 700, avg_damage: 600, min_damage: 400, max_damage: 800, count: 5 }],
    }],
    top_defensives_summary: [{ spell_id: CLOAK_OF_SHADOWS, avg_uses: 2, min_uses: 1, max_uses: 3 }],
    defensives: [CLOAK_META],
    cd_spell_ids: { 'Cloak of Shadows': CLOAK_OF_SHADOWS },
    ability_icons: { [CLOAK_OF_SHADOWS]: { icon: 'cloak', name: 'Cloak of Shadows' }, 700: { icon: 'hit', name: 'Boss Hit' } },
  };
}

function serviceWith(bench: DefensiveBench | null, wcl: Record<string, unknown> = {}): DefensiveFeatureService {
  const source: DefensiveDataSource = { getDefensiveBench: () => Promise.resolve(bench) };
  TestBed.configureTestingModule({
    providers: [
      { provide: DEFENSIVE_DATA_SOURCE, useValue: source },
      { provide: WclApiService, useValue: wcl as unknown as WclApiService },
    ],
  });
  return TestBed.inject(DefensiveFeatureService);
}

describe('DefensiveFeatureService.loadAnalysisView (post-raid)', () => {
  it('returns an empty view when the bench file is absent', async () => {
    const service = serviceWith(null);
    expect(await service.loadAnalysisView('SubtletyRogue', 1, 'r1', 1, 10))
      .toEqual({ findings: [], spellIdsByName: {}, iconByName: {}, windows: [], anchors: [] });
  });

  it('computes player findings + windows from the player log', async () => {
    const report = {
      title: 't',
      fights: [{ id: 1, name: 'Boss', startTime: 0, endTime: 300_000, kill: true, encounterID: 1, friendlyPlayers: [] }],
      masterData: { actors: [{ id: 10, name: 'P', subType: 'Rogue', server: '' }], abilities: [{ gameID: 700, name: 'Boss Hit', icon: 'hit' }] },
    };
    const wcl = {
      getReport: async () => report,
      getAllEvents: async (_c: string, _f: number, dataType: string) => {
        if (dataType === 'Buffs') return [applybuff(CLOAK_OF_SHADOWS, 30), removebuff(CLOAK_OF_SHADOWS, 35)];
        if (dataType === 'Casts') return [];
        return [dtaken(700, 32, 1150)]; // DamageTaken inside window
      },
    };
    const service = serviceWith(fullBench(), wcl);
    const view = await service.loadAnalysisView('SubtletyRogue', 1, 'r1', 1, 10);
    expect(view.spellIdsByName).toEqual({ 'Cloak of Shadows': CLOAK_OF_SHADOWS });
    expect(view.windows).toHaveLength(1);
    expect(view.windows[0].overview.playerPct).toBe(1150);
    expect(view.anchors[0]).toMatchObject({ refGameId: 6666 });
    // 1 use vs avg ~2, but only one buff window -> first cast at 30 (late) gives a warning finding.
    expect(view.findings.length).toBeGreaterThan(0);
  });
});

describe('DefensiveFeatureService.loadPlan (pre-fight)', () => {
  it('returns the bench-only plan rows', async () => {
    const service = serviceWith(fullBench());
    const rows = await service.loadPlan('SubtletyRogue', 1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'Cloak of Shadows', spellId: CLOAK_OF_SHADOWS, uses: 2, firstCastS: 10, windowsS: [30] });
  });

  it('returns [] when the bench file is absent', async () => {
    const service = serviceWith(null);
    expect(await service.loadPlan('SubtletyRogue', 1)).toEqual([]);
  });
});
