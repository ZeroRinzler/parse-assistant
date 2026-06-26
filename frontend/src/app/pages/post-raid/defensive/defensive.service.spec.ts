import { describe, it, expect } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { WclApiService } from '../../../core/services/wcl-api';
import { WclEvent } from '../../../core/models/wcl.models';
import { BurstWindow, PlayerBurstWindow } from '../../../core/models/analysis.models';
import { PerDefensiveBenchmark } from '../../../core/models/encounter.models';
import { DEFENSIVE_DATA_SOURCE, DefensiveBench, DefensiveDataSource } from './defensive-data-source';
import {
  DefensiveFeatureService,
  analyzeDefensives, analyzeDefensiveFindings, computePlayerDefensiveWindows,
  defensiveWindowStatus, defensiveMapAnchor, buildDefensiveWindows, buildDefensivePlanRows,
} from './defensive.service';

function applybuff(spellId: number, atS: number): WclEvent {
  return { type: 'applybuff', timestamp: atS * 1000, abilityGameID: spellId };
}
function removebuff(spellId: number, atS: number): WclEvent {
  return { type: 'removebuff', timestamp: atS * 1000, abilityGameID: spellId };
}
function dtaken(spellId: number, atS: number, amount: number): WclEvent {
  return { type: 'damage', timestamp: atS * 1000, abilityGameID: spellId, amount };
}

const CLOAK_META = { name: 'Cloak of Shadows', spell_id: 31224, cooldown: 120, duration: 5, usage_rule: 'Use on big hits', talent_gated: false };

/* ----------------------------- player defensives ----------------------------- */

describe('analyzeDefensives', () => {
  it('builds buff-window-centric uses with damage taken during each window', () => {
    const out = analyzeDefensives(
      [CLOAK_META],
      [], [applybuff(31224, 10), removebuff(31224, 15)], [dtaken(700, 12, 500)],
      0, 300_000,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ name: 'Cloak of Shadows', uses: 1, cast_times_s: [10] });
    expect(out[0].windows[0]).toMatchObject({ start_s: 10, end_s: 15, dmg_during: 500 });
  });

  it('falls back to explicit casts (cast+duration window) when no buffs exist', () => {
    const out = analyzeDefensives(
      [CLOAK_META],
      [{ type: 'cast', timestamp: 20_000, abilityGameID: 31224 }], [], [dtaken(700, 21, 300)],
      0, 300_000,
    );
    expect(out[0]).toMatchObject({ uses: 1, cast_times_s: [20] });
    expect(out[0].windows[0]).toMatchObject({ start_s: 20, end_s: 25, dmg_during: 300 });
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
      [{ name: 'Cloak of Shadows', spell_id: 31224, cooldown: 120, uses: 0, cast_times_s: [], windows: [] }],
      bench, 300,
    );
    expect(findings[0]).toMatchObject({ severity: 'critical', category: 'lost_cooldown', cd_name: 'Cloak of Shadows' });
  });

  it('emits a success when usage matches and there are no issues', () => {
    const findings = analyzeDefensiveFindings(
      [{ name: 'Cloak of Shadows', spell_id: 31224, cooldown: 120, uses: 2, cast_times_s: [10, 70], windows: [] }],
      bench, 300,
    );
    expect(findings.some(f => f.severity === 'success' && f.cd_name === 'Cloak of Shadows')).toBe(true);
  });

  it('flags a late first use as a warning', () => {
    const findings = analyzeDefensiveFindings(
      [{ name: 'Cloak of Shadows', spell_id: 31224, cooldown: 120, uses: 1, cast_times_s: [40], windows: [] }],
      bench, 300,
    );
    expect(findings.some(f => f.severity === 'warning' && f.category === 'cooldown_delay')).toBe(true);
  });

  it('skips a talent-gated defensive that was never used', () => {
    const findings = analyzeDefensiveFindings(
      [{ name: 'Cloak of Shadows', spell_id: 31224, cooldown: 120, uses: 0, cast_times_s: [], windows: [], talent_gated: true }],
      bench, 300,
    );
    expect(findings).toEqual([]);
  });
});

describe('computePlayerDefensiveWindows', () => {
  it('sums player damage taken inside each top defensive window (half-open)', () => {
    const top: BurstWindow[] = [
      { time_s: 10, window_length_s: 5, dmg_avg: 0, dmg_min: 0, dmg_max: 0, dmg_stddev: 0, ability_breakdown: [] },
    ];
    const out = computePlayerDefensiveWindows(top, [dtaken(700, 12, 400), dtaken(701, 14, 100), dtaken(700, 15, 999)], 0);
    expect(out[0].window_damage).toBe(500); // event at exactly 15 (== end) excluded
    expect(out[0].ability_breakdown![0]).toMatchObject({ spell_id: 700, damage: 400 });
  });
});

/* ----------------------------- defensive windows view ----------------------------- */

describe('defensiveWindowStatus', () => {
  // topAvg 1000, topMax 1200, stddev 100 -> bad above 1300, warn above 1100. Lower is better.
  it.each([
    { name: 'not reached -> muted', player: 950 as number | null, notReached: true, status: 'muted', icon: 'schedule' },
    { name: 'missing -> muted', player: null, notReached: false, status: 'muted', icon: 'help_outline' },
    { name: 'far above max -> bad', player: 1400, notReached: false, status: 'bad', icon: 'error' },
    { name: 'above avg band -> warn', player: 1150, notReached: false, status: 'warn', icon: 'warning_amber' },
    { name: 'within range -> good', player: 1000, notReached: false, status: 'good', icon: 'check_circle' },
  ])('$name', ({ player, notReached, status, icon }) => {
    expect(defensiveWindowStatus(player, 1000, 1200, 100, notReached)).toEqual({ status, icon });
  });
});

describe('defensiveMapAnchor', () => {
  it('carries seek time, label, defensive spell id and the dominant enemy game id', () => {
    const window = { time_s: 30, window_length_s: 5, defensive_name: 'Cloak of Shadows', spell_id: 31224, ref_game_id: 6666 } as BurstWindow;
    expect(defensiveMapAnchor(window)).toEqual({ timeS: 30, label: 'Cloak of Shadows', spellIds: [31224], refGameId: 6666 });
  });

  it('falls back to a generic label and null ref when absent', () => {
    const window = { time_s: 5, window_length_s: 5 } as BurstWindow;
    expect(defensiveMapAnchor(window)).toEqual({ timeS: 5, label: 'Defensive', spellIds: [], refGameId: null });
  });
});

describe('buildDefensiveWindows', () => {
  const window: BurstWindow = {
    time_s: 30, window_length_s: 5, dmg_avg: 1000, dmg_min: 800, dmg_max: 1200, dmg_stddev: 100,
    defensive_name: 'Cloak of Shadows', spell_id: 31224, ref_game_id: 6666,
    ability_breakdown: [{ spell_id: 700, avg_damage: 600, min_damage: 400, max_damage: 800, count: 5 }],
  };

  it('pairs each window with player damage taken at the same index', () => {
    const player: PlayerBurstWindow[] = [{ time_s: 30, window_damage: 1150, ability_breakdown: [{ spell_id: 700, damage: 700 }] }];
    const { windows, anchors } = buildDefensiveWindows([window], player, 300, () => 'Boss Hit');
    expect(windows[0].overview.playerPct).toBe(1150);
    expect(windows[0].status).toBe('warn');
    expect(windows[0].spellIds).toEqual([31224]);
    expect(windows[0].detailRows[0]).toMatchObject({ spellId: 700, label: 'Boss Hit', playerPct: 700, topAvg: 600 });
    expect(anchors[0]).toEqual({ timeS: 30, label: 'Cloak of Shadows', spellIds: [31224], refGameId: 6666 });
  });

  it('mutes and drops player data for a window the fight never reached', () => {
    const { windows } = buildDefensiveWindows([window], [], 5, id => `Spell ${id}`);
    expect(windows[0].status).toBe('muted');
    expect(windows[0].overview.playerPct).toBeNull();
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
      defensives: [{ name: 'Cloak of Shadows', spell_id: 31224, cooldown: 120, duration: 5, usage_rule: 'Use it', talent_gated: false }],
      per_defensive_benchmarks: {
        'Cloak of Shadows': {
          sample_count: 5, avg_first_cast_s: 12, stddev_first_cast_s: 2, avg_gap_s: null, stddev_gap_s: null,
          hold_targets: {}, avg_uses: 2, avg_uses_per_min: 0.4, uses_per_min: { avg: 0.4, stddev: 0.05, min: 0.3, max: 0.5 },
          majority_hold: false,
        },
      },
      defensive_windows: [{ time_s: 30, window_length_s: 5, dmg_avg: 0, dmg_min: 0, dmg_max: 0, dmg_stddev: 0, defensive_name: 'Cloak of Shadows', ability_breakdown: [] }],
    });
    const rows = buildDefensivePlanRows(bench);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'Cloak of Shadows', spellId: 31224, uses: 2, firstCastS: 12, windowsS: [30], rule: 'Use it' });
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
      defensive_name: 'Cloak of Shadows', spell_id: 31224, ref_game_id: 6666,
      ability_breakdown: [{ spell_id: 700, avg_damage: 600, min_damage: 400, max_damage: 800, count: 5 }],
    }],
    top_defensives_summary: [{ spell_id: 31224, avg_uses: 2, min_uses: 1, max_uses: 3 }],
    defensives: [CLOAK_META],
    cd_spell_ids: { 'Cloak of Shadows': 31224 },
    ability_icons: { 700: { icon: 'hit', name: 'Boss Hit' } },
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
        if (dataType === 'Buffs') return [applybuff(31224, 30), removebuff(31224, 35)];
        if (dataType === 'Casts') return [];
        return [dtaken(700, 32, 1150)]; // DamageTaken inside window
      },
    };
    const service = serviceWith(fullBench(), wcl);
    const view = await service.loadAnalysisView('SubtletyRogue', 1, 'r1', 1, 10);
    expect(view.spellIdsByName).toEqual({ 'Cloak of Shadows': 31224 });
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
    expect(rows[0]).toMatchObject({ name: 'Cloak of Shadows', spellId: 31224, uses: 2, firstCastS: 10, windowsS: [30] });
  });

  it('returns [] when the bench file is absent', async () => {
    const service = serviceWith(null);
    expect(await service.loadPlan('SubtletyRogue', 1)).toEqual([]);
  });
});
