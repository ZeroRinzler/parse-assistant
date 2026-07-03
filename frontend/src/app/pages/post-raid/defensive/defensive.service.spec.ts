import { describe, it, expect } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { WclApiService } from '../../../core/services/wcl-api';
import { WclEvent } from '../../../core/models/wcl.models';
import { BurstWindow, PlayerBurstWindow, PlayerDefensive } from '../../../core/models/analysis.models';
import { PerDefensiveBenchmark } from '../../../core/models/encounter.models';
import { DEFENSIVE_DATA_SOURCE, DefensiveBench } from './defensive-data-source';
import { DataSource } from '../../../core/data-source/data-source';
import {
  DefensiveFeatureService,
  analyzeDefensives, analyzeDefensiveFindings, computePlayerDefensiveWindows,
  defensiveWindowStatus, defensiveMapAnchor, buildDefensiveWindows, buildDefensivePlanRows,
  playerCoveredWindow, playerUsefulTiming, windowMissFindings,
  buildDefensiveUsageWindows, analyzeOneDefensive, gapDelayFindings, holdSuggestionFindings,
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

describe('buildDefensiveUsageWindows', () => {
  // The buff/cast fight window the fixtures live inside.
  const F_START = 0;
  const F_END = 300_000;
  const FIGHT_END_S = 300;
  const rel = (ts: number): number => ts - F_START;
  // A constant damage-in-window function so each span's dmg_during is predictable.
  const FIXED_DMG = 500;
  const dmg = (): number => FIXED_DMG;

  it('builds a measured buff span with damage taken, open buff running to fight end', () => {
    const BUFF_START_S = 10;
    const out = buildDefensiveUsageWindows(CLOAK_OF_SHADOWS, [[BUFF_START_S, null]], [], dmg, rel, F_START, F_END, FIGHT_END_S);
    expect(out).toEqual([{ start_s: BUFF_START_S, end_s: FIGHT_END_S, dmg_during: FIXED_DMG }]);
  });

  it('falls back to point casts (zero span, no damage) only when there is no buff span', () => {
    const CAST_S = 20;
    const out = buildDefensiveUsageWindows(
      CLOAK_OF_SHADOWS, [], [{ type: 'cast', timestamp: CAST_S * 1000, abilityGameID: CLOAK_OF_SHADOWS }],
      dmg, rel, F_START, F_END, FIGHT_END_S,
    );
    expect(out).toEqual([{ start_s: CAST_S, end_s: CAST_S, dmg_during: 0 }]);
  });

  it('ignores a cast outside the fight bounds (boundary)', () => {
    const PAST_END_S = 301; // > FIGHT_END_S, so its timestamp is past F_END
    const out = buildDefensiveUsageWindows(
      CLOAK_OF_SHADOWS, [], [{ type: 'cast', timestamp: PAST_END_S * 1000, abilityGameID: CLOAK_OF_SHADOWS }],
      dmg, rel, F_START, F_END, FIGHT_END_S,
    );
    expect(out).toEqual([]);
  });
});

describe('gapDelayFindings', () => {
  // avg_gap 60, stddev 5 -> +2sigma band is 70; a gap must STRICTLY exceed 70 to flag.
  const AVG_GAP_S = 60;
  const STDDEV_GAP_S = 5;
  const benchWithGap = (overrides: Partial<PerDefensiveBenchmark> = {}): PerDefensiveBenchmark => ({
    sample_count: 5, used_sample_count: 5, avg_first_cast_s: 10, stddev_first_cast_s: 2, avg_gap_s: AVG_GAP_S, stddev_gap_s: STDDEV_GAP_S,
    hold_targets: {}, avg_uses: 2, avg_uses_per_min: 0.4, uses_per_min: { avg: 0.4, stddev: 0.05, min: 0.3, max: 0.5 },
    majority_hold: false, ...overrides,
  });

  it('flags a gap beyond the +2sigma band', () => {
    const GAP_OVER = 71; // 71 > 70
    const out = gapDelayFindings('Cloak of Shadows', [0, GAP_OVER], benchWithGap());
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ severity: 'warning', category: 'cooldown_delay' });
  });

  it('does not flag a gap exactly at the band (strict boundary)', () => {
    const GAP_AT_BAND = AVG_GAP_S + 2 * STDDEV_GAP_S; // 70, not an outlier
    expect(gapDelayFindings('Cloak of Shadows', [0, GAP_AT_BAND], benchWithGap())).toEqual([]);
  });

  it('emits nothing when the bench has no gap statistic', () => {
    expect(gapDelayFindings('Cloak of Shadows', [0, 999], benchWithGap({ avg_gap_s: null, stddev_gap_s: null }))).toEqual([]);
  });
});

describe('holdSuggestionFindings', () => {
  const NAME = 'Cloak of Shadows';
  // Prior-relative band (mirrors rotation): the top parses hold this cast HOLD_DELAY_S past the
  // reset, and the runtime flags an under-hold only when the player's own gap from their prior
  // cast is more than HOLD_BAND_S below that. Over-holding is tolerated.
  const HELD_CAST_INDEX = 2;      // the second use (1-based key)
  const EFFECTIVE_CD_S = 60;      // the defensive's cooldown (cadence zero-point)
  const HOLD_DELAY_S = 40;        // top parses hold ~40s past the reset
  const HOLD_BAND_S = 5;          // tolerance half-width -> flag below HOLD_DELAY_S - HOLD_BAND_S
  const TARGET_CLOCK_S = 130;     // display-only median clock target ("hold to 2:10")
  const HELD_COUNT = 6;           // "6 of 10 top parses hold" copy
  const TOTAL_SAMPLED = 10;
  const PRIOR_CAST_S = 10;
  // A gap of exactly EFFECTIVE_CD_S + HOLD_DELAY_S - HOLD_BAND_S past the prior cast sits on the
  // band edge; below it flags, at/above it does not.
  const BAND_EDGE_S = PRIOR_CAST_S + EFFECTIVE_CD_S + (HOLD_DELAY_S - HOLD_BAND_S);
  const UNDER_HELD_S = BAND_EDGE_S - 5;  // clearly below the band edge
  const OVER_HELD_S = PRIOR_CAST_S + EFFECTIVE_CD_S + HOLD_DELAY_S + 20; // past the band (tolerated)

  const holdTargets: PerDefensiveBenchmark['hold_targets'] = {
    [HELD_CAST_INDEX]: {
      target_s: TARGET_CLOCK_S, stddev_s: HOLD_BAND_S,
      delay_s: HOLD_DELAY_S, delay_stddev_s: 3, band_s: HOLD_BAND_S, effective_cd_s: EFFECTIVE_CD_S,
      count: HELD_COUNT, total_samples: TOTAL_SAMPLED,
    },
  };

  it('suggests a hold when the player under-held vs the prior-relative band', () => {
    const out = holdSuggestionFindings(NAME, [PRIOR_CAST_S, UNDER_HELD_S], holdTargets);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ severity: 'info', category: 'hold_suggestion' });
  });

  it('does not suggest at the band edge (strict boundary)', () => {
    expect(holdSuggestionFindings(NAME, [PRIOR_CAST_S, BAND_EDGE_S], holdTargets)).toEqual([]);
  });

  it('tolerates over-holding (a later-than-band press is fine)', () => {
    expect(holdSuggestionFindings(NAME, [PRIOR_CAST_S, OVER_HELD_S], holdTargets)).toEqual([]);
  });

  it('skips index 0 - no prior cast to measure a gap against', () => {
    const FIRST_CAST_INDEX = 1;
    const PLAYER_FIRST_S = 80;
    const firstOnly: PerDefensiveBenchmark['hold_targets'] = {
      [FIRST_CAST_INDEX]: {
        target_s: TARGET_CLOCK_S, stddev_s: HOLD_BAND_S,
        delay_s: HOLD_DELAY_S, delay_stddev_s: 3, band_s: HOLD_BAND_S, effective_cd_s: EFFECTIVE_CD_S,
        count: HELD_COUNT, total_samples: TOTAL_SAMPLED,
      },
    };
    expect(holdSuggestionFindings(NAME, [PLAYER_FIRST_S], firstOnly)).toEqual([]);
  });

  it('skips a cast index the player never reached', () => {
    expect(holdSuggestionFindings(NAME, [PRIOR_CAST_S], holdTargets)).toEqual([]);
  });
});

describe('analyzeOneDefensive', () => {
  const bench: PerDefensiveBenchmark = {
    sample_count: 10, used_sample_count: 10, avg_first_cast_s: 10, stddev_first_cast_s: 2, avg_gap_s: 60, stddev_gap_s: 5,
    hold_targets: {}, avg_uses: 2, avg_uses_per_min: 0.4, uses_per_min: { avg: 0.4, stddev: 0.05, min: 0.3, max: 0.5 },
    majority_hold: false,
  };
  const player = (overrides: Partial<PlayerDefensive>): PlayerDefensive =>
    ({ name: 'Cloak of Shadows', spell_id: CLOAK_OF_SHADOWS, cooldown: 120, uses: 0, cast_times_s: [], windows: [], ...overrides });
  const FIGHT_DUR_S = 300;

  it('flags a never-used defensive as a critical lost cooldown', () => {
    const out = analyzeOneDefensive(player({ uses: 0, cast_times_s: [] }), bench, 300);
    expect(out[0]).toMatchObject({ severity: 'critical', category: 'lost_cooldown' });
  });

  // used_sample_count / sample_count below MIN_USE_SHARE_FRAC (0.5) -> a situational defensive.
  const TOTAL_SAMPLED = 10;
  const MINORITY_USERS = 3;       // 3/10 = 30% < 50%
  const minorityUse: PerDefensiveBenchmark = { ...bench, sample_count: TOTAL_SAMPLED, used_sample_count: MINORITY_USERS };

  it('does not flag an unused defensive that only a minority of top parses use (use-share gate)', () => {
    // The player matching the top parses by not pressing it is not a lost cast.
    expect(analyzeOneDefensive(player({ uses: 0, cast_times_s: [] }), minorityUse, FIGHT_DUR_S)).toEqual([]);
  });

  it('does not flag a late first use of a minority-use defensive (use-share gate)', () => {
    // First use is well past avg 10 + 2*stddev 2 = 14s, but the first-cast check is gated off.
    const LATE_FIRST_S = 40;
    const out = analyzeOneDefensive(player({ uses: 1, cast_times_s: [LATE_FIRST_S] }), minorityUse, FIGHT_DUR_S);
    expect(out.some(finding => finding.category === 'cooldown_delay')).toBe(false);
  });

  it('returns a success (no issues) when usage matches', () => {
    const out = analyzeOneDefensive(player({ uses: 2, cast_times_s: [10, 70] }), bench, 300);
    expect(out.some(finding => finding.severity === 'success')).toBe(true);
  });

  it('skips a talent-gated defensive that was never used', () => {
    expect(analyzeOneDefensive(player({ uses: 0, talent_gated: true }), bench, 300)).toEqual([]);
  });

  it('records a no-bench success only when used', () => {
    expect(analyzeOneDefensive(player({ uses: 1, cast_times_s: [10] }), undefined, 300)[0]).toMatchObject({ severity: 'success' });
    expect(analyzeOneDefensive(player({ uses: 0 }), undefined, 300)).toEqual([]);
  });
});

describe('analyzeDefensiveFindings', () => {
  const bench: Record<string, PerDefensiveBenchmark> = {
    'Cloak of Shadows': {
      sample_count: 10, used_sample_count: 10, avg_first_cast_s: 10, stddev_first_cast_s: 2,
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
    const { windows, anchors } = buildDefensiveWindows({ topWindows: [window], playerWindows: player, playerDefensives: playerDef, fightDurationS: 300, abilities });
    expect(windows[0].overview.playerPct).toBe(1150);
    expect(windows[0].status).toBe('warn');
    expect(windows[0].spells).toEqual([{ id: CLOAK_OF_SHADOWS, icon: 'cloak', name: 'Cloak of Shadows' }]);
    expect(windows[0].detailRows[0]).toMatchObject({ spellId: 700, label: 'Boss Hit', icon: 'hit', playerPct: 700, topAvg: 600 });
    expect(anchors[0]).toEqual({ timeS: 30, label: 'Cloak of Shadows', spells: [{ id: CLOAK_OF_SHADOWS, icon: 'cloak', name: 'Cloak of Shadows' }], refGameId: 6666 });
  });

  it('marks an uncovered window bad', () => {
    const player: PlayerBurstWindow[] = [{ time_s: 30, window_damage: 900, ability_breakdown: [] }];
    const { windows } = buildDefensiveWindows({ topWindows: [window], playerWindows: player, playerDefensives: [], fightDurationS: 300, abilities });
    expect(windows[0].status).toBe('bad');
  });

  it('mutes and drops player data for a window the fight never reached', () => {
    const { windows } = buildDefensiveWindows({ topWindows: [window], playerWindows: [], playerDefensives: [], fightDurationS: 5, abilities });
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
          sample_count: 5, used_sample_count: 5, avg_first_cast_s: 12, stddev_first_cast_s: 2, avg_gap_s: null, stddev_gap_s: null,
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
        sample_count: 5, used_sample_count: 5, avg_first_cast_s: 10, stddev_first_cast_s: 2, avg_gap_s: 60, stddev_gap_s: 5,
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
  const source: DataSource<DefensiveBench> = { getBench: () => Promise.resolve(bench) };
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
