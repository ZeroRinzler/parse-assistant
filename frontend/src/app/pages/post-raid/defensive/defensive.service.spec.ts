import { assert, describe, it, expect } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { WclApiService } from '../../../core/services/wcl-api';
import { BurstWindow, PlayerBurstWindow, PlayerDefensive } from '../../../core/models/analysis.models';
import { PerDefensiveBenchmark } from '../../../core/models/encounter.models';
import { DEFENSIVE_DATA_SOURCE, DefensiveBench } from './defensive-data-source';
import { DataSource } from '../../../core/data-source/data-source';
import {
  DefensiveFeatureService,
  analyzeDefensives, analyzeDefensiveFindings, computePlayerDefensiveWindows,
  defensiveWindowStatus, defensiveMapAnchor, defensiveClipAnchor, defensiveFindingClipAnchor, buildDefensiveWindows, buildDefensivePlanRows,
  defensiveDetailRows,
  playerCoveredWindow,
  buildDefensiveUsageWindows, analyzeOneDefensive, gapDelayFindings,
} from './defensive.service';
import { applyBuff, removeBuff, damageTaken, cast } from '../../../../testing/builders/events';
import { CLOAK_OF_SHADOWS } from '../../../../testing/spell-ids';
import {
  WCL_MELEE_EVENT_ABILITY_ID, WOW_AUTO_ATTACK_SPELL_ID, WCL_SYNTHETIC_SOURCE_FALLBACK_ID, withRelativeS,
} from '../../../shared/analysis/wcl-projections';
import { Result, ok, missing, transient } from '../../../core/result';

/** Fixture events build against a fight-start of 0, so stamping is a pass-through to seconds. */
const timed = withRelativeS;

const CLOAK_META = { name: 'Cloak of Shadows', spell_id: CLOAK_OF_SHADOWS, cooldown: 120, usage_rule: 'Use on big hits', talent_gated: false };

function defBench(overrides: Partial<PerDefensiveBenchmark> = {}): PerDefensiveBenchmark {
  return {
    sample_count: 5, used_sample_count: 5, avg_first_cast_s: 10, stddev_first_cast_s: 2, avg_gap_s: 60, stddev_gap_s: 5,
    hold_targets: {}, median_uses: 2, uses_per_min: { avg: 0.4, stddev: 0.05 },
    majority_hold: false,
    ...overrides,
  };
}

describe('analyzeDefensives', () => {
  // Composition only: span shapes and fallbacks are specced on buildDefensiveUsageWindows.
  it('builds buff-window-centric uses', () => {
    const out = analyzeDefensives(
      [CLOAK_META],
      [], timed([applyBuff(CLOAK_OF_SHADOWS, 10), removeBuff(CLOAK_OF_SHADOWS, 15)], 0),
      300,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ name: 'Cloak of Shadows', uses: 1, cast_times_s: [10] });
    assert.exists(out[0]);
    expect(out[0].windows[0]).toMatchObject({ start_s: 10, end_s: 15 });
  });

  // Composition only: back-fill semantics are specced on buildAuraWindows.
  it('reads a bare removeBuff with no preceding apply as one use starting at 0:00', () => {
    const REMOVE_S = 15;
    const out = analyzeDefensives(
      [CLOAK_META],
      [], timed([removeBuff(CLOAK_OF_SHADOWS, REMOVE_S)], 0),
      300,
    );
    expect(out[0]).toMatchObject({ uses: 1, cast_times_s: [0] });
    assert.exists(out[0]);
    expect(out[0].windows[0]).toMatchObject({ start_s: 0, end_s: REMOVE_S });
  });
});

describe('buildDefensiveUsageWindows', () => {
  const FIGHT_END_S = 300;

  it('builds a measured buff span, open buff running to fight end', () => {
    const BUFF_START_S = 10;
    const out = buildDefensiveUsageWindows(CLOAK_OF_SHADOWS, [[BUFF_START_S, null]], [], FIGHT_END_S);
    expect(out).toEqual([{ start_s: BUFF_START_S, end_s: FIGHT_END_S }]);
  });

  it('falls back to point casts (zero span) only when there is no buff span', () => {
    const CAST_S = 20;
    const out = buildDefensiveUsageWindows(
      CLOAK_OF_SHADOWS, [], timed([cast(CLOAK_OF_SHADOWS, CAST_S)], 0),
      FIGHT_END_S,
    );
    expect(out).toEqual([{ start_s: CAST_S, end_s: CAST_S }]);
  });

  it('ignores a cast outside the fight bounds (boundary)', () => {
    const PAST_END_S = 301; // > FIGHT_END_S
    const out = buildDefensiveUsageWindows(
      CLOAK_OF_SHADOWS, [], timed([cast(CLOAK_OF_SHADOWS, PAST_END_S)], 0),
      FIGHT_END_S,
    );
    expect(out).toEqual([]);
  });
});

describe('gapDelayFindings', () => {
  // avg_gap 60, stddev 5 -> +2sigma band is 70; a gap must STRICTLY exceed 70 to flag.
  const AVG_GAP_S = 60;
  const STDDEV_GAP_S = 5;
  const benchWithGap = (overrides: Partial<PerDefensiveBenchmark> = {}): PerDefensiveBenchmark =>
    defBench({ avg_gap_s: AVG_GAP_S, stddev_gap_s: STDDEV_GAP_S, ...overrides });

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

describe('analyzeOneDefensive', () => {
  // Full use-share bench (10/10 top parses used it), so no check is use-share gated.
  const bench = defBench({ sample_count: 10, used_sample_count: 10 });
  const player = (overrides: Partial<PlayerDefensive>): PlayerDefensive =>
    ({ name: 'Cloak of Shadows', uses: 0, cast_times_s: [], windows: [], ...overrides });
  const FIGHT_DUR_S = 300;

  it('flags a never-used defensive as a critical lost cooldown', () => {
    const out = analyzeOneDefensive(player({ uses: 0, cast_times_s: [] }), bench, 300);
    expect(out[0]).toMatchObject({ severity: 'critical', category: 'lost_cooldown' });
  });

  it('flags a late first use as a warning', () => {
    // First use is well past avg 10 + 2*stddev 2 = 14s -> a first-cast delay warning.
    const LATE_FIRST_S = 40;
    const out = analyzeOneDefensive(player({ uses: 1, cast_times_s: [LATE_FIRST_S] }), bench, FIGHT_DUR_S);
    expect(out.some(finding => finding.severity === 'warning' && finding.category === 'cooldown_delay')).toBe(true);
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
  // Composition only: per-defensive checks are specced on analyzeOneDefensive.
  const bench: Record<string, PerDefensiveBenchmark> = { 'Cloak of Shadows': defBench({ sample_count: 10, used_sample_count: 10 }) };

  it('flags a never-used defensive as a critical lost cooldown', () => {
    const findings = analyzeDefensiveFindings(
      [{ name: 'Cloak of Shadows', uses: 0, cast_times_s: [], windows: [] }],
      bench, 300,
    );
    expect(findings[0]).toMatchObject({ severity: 'critical', category: 'lost_cooldown', cd_name: 'Cloak of Shadows' });
  });
});

describe('computePlayerDefensiveWindows', () => {
  it('sums player damage taken inside each top defensive window (half-open, amount + absorbed)', () => {
    const top: BurstWindow[] = [
      { time_s: 10, window_length_s: 5, dmg_avg: 0, dmg_min: 0, dmg_max: 0, dmg_stddev: 0, common_cds: [], ability_breakdown: [] },
    ];
    const out = computePlayerDefensiveWindows(top, timed([damageTaken(700, 12, 400, { absorbed: 150 }), damageTaken(701, 14, 100), damageTaken(700, 15, 999)], 0));
    // (400 + 150 absorbed) + 100 = 650; the event at exactly 15 (== end) is excluded (half-open).
    assert.exists(out[0]);
    expect(out[0].window_damage).toBe(650);
    assert.exists(out[0]);
    assert.exists(out[0].ability_breakdown);
    expect(out[0].ability_breakdown[0]).toMatchObject({ spell_id: 700, damage: 550 });
  });

  it('folds melee and synthetic-negative ability ids to normalized spell ids so the bench detail join resolves', () => {
    const WIN_START_S = 10;
    const WIN_LEN_S = 5;
    const MELEE_HIT_A = 400;
    const MELEE_HIT_B = 100;
    const SYNTH_NEG_ID_A = -32;   // WCL synthesizes distinct negative ids for sourceless hits
    const SYNTH_NEG_ID_B = -45;
    const SYNTH_HIT_A = 300;
    const SYNTH_HIT_B = 250;
    const MELEE_TOTAL = MELEE_HIT_A + MELEE_HIT_B;
    const SYNTH_TOTAL = SYNTH_HIT_A + SYNTH_HIT_B;
    // The bench breakdown stores NORMALIZED spell ids, so the player fold must match or the join renders null.
    const top: BurstWindow[] = [{
      time_s: WIN_START_S, window_length_s: WIN_LEN_S, dmg_avg: 0, dmg_min: 0, dmg_max: 0, dmg_stddev: 0, common_cds: [],
      ability_breakdown: [
        { spell_id: WOW_AUTO_ATTACK_SPELL_ID, avg_damage: 0, min_damage: 0, max_damage: 0 },
        { spell_id: WCL_SYNTHETIC_SOURCE_FALLBACK_ID, avg_damage: 0, min_damage: 0, max_damage: 0 },
      ],
    }];
    const [playerWindow] = computePlayerDefensiveWindows(top, timed([
      damageTaken(WCL_MELEE_EVENT_ABILITY_ID, WIN_START_S + 1, MELEE_HIT_A),
      damageTaken(WCL_MELEE_EVENT_ABILITY_ID, WIN_START_S + 2, MELEE_HIT_B),
      damageTaken(SYNTH_NEG_ID_A, WIN_START_S + 2, SYNTH_HIT_A),
      damageTaken(SYNTH_NEG_ID_B, WIN_START_S + 3, SYNTH_HIT_B),
    ], 0));

    assert.exists(playerWindow);
    assert.exists(playerWindow.ability_breakdown);
    const breakdown = playerWindow.ability_breakdown;
    expect(breakdown).toContainEqual({ spell_id: WOW_AUTO_ATTACK_SPELL_ID, damage: MELEE_TOTAL });
    expect(breakdown).toContainEqual({ spell_id: WCL_SYNTHETIC_SOURCE_FALLBACK_ID, damage: SYNTH_TOTAL });

    const abilities = {
      [WOW_AUTO_ATTACK_SPELL_ID]: { icon: 'melee', name: 'Auto Attack' },
      [WCL_SYNTHETIC_SOURCE_FALLBACK_ID]: { icon: '', name: 'Unknown Source' },
    };
    assert.exists(top[0]);
    assert.exists(playerWindow);
    const rows = defensiveDetailRows(top[0].ability_breakdown, playerWindow, abilities);
    expect(rows.find(row => row.spellId === WOW_AUTO_ATTACK_SPELL_ID)?.playerPct).toBe(MELEE_TOTAL);
    expect(rows.find(row => row.spellId === WCL_SYNTHETIC_SOURCE_FALLBACK_ID)?.playerPct).toBe(SYNTH_TOTAL);
  });
});

describe('defensiveDetailRows', () => {
  it('labels an ability whose spell id is missing from the ability map with a placeholder and empty icon', () => {
    // 900 is intentionally absent from the ability map, so the guarded lookup must not throw.
    const breakdown = [{ spell_id: 900, avg_damage: 600, min_damage: 400, max_damage: 800, count: 5 }];
    const rows = defensiveDetailRows(breakdown, null, {});
    assert.exists(rows[0]);
    expect(rows[0].label).toBe('Ability #900');
    assert.exists(rows[0]);
    expect(rows[0].icon).toBe('');
  });

  it('resolves an ability present in the map to its baked name and icon', () => {
    const breakdown = [{ spell_id: 700, avg_damage: 600, min_damage: 400, max_damage: 800, count: 5 }];
    const rows = defensiveDetailRows(breakdown, null, { 700: { icon: 'hit', name: 'Boss Hit' } });
    assert.exists(rows[0]);
    expect(rows[0].label).toBe('Boss Hit');
    assert.exists(rows[0]);
    expect(rows[0].icon).toBe('hit');
  });
});

describe('defensiveWindowStatus', () => {
  // Status is driven by damage TAKEN vs the band, not by coverage. Band edge = topMax + stddev.
  const TOP_MAX = 1200;
  const STDDEV = 100;
  const BAND_EDGE = TOP_MAX + STDDEV;        // 1300 - damage above this is bad
  const WITHIN_BAND = TOP_MAX;               // 1200 - within/below the band
  const ABOVE_BAND = BAND_EDGE + 1;          // 1301 - strictly above the band

  it.each([
    // Not reached / no player data -> muted, no annotation (coverage irrelevant).
    { name: 'not reached -> muted', player: 950, notReached: true, covered: true, status: 'muted', icon: 'schedule', note: '' },
    { name: 'missing -> muted', player: null, notReached: false, covered: true, status: 'muted', icon: 'help_outline', note: '' },
    // Within/below the band -> good, whether or not the defensive was pressed.
    { name: 'within band, covered -> good (covered)', player: WITHIN_BAND, notReached: false, covered: true, status: 'good', icon: 'check_circle', note: 'covered' },
    { name: 'within band, not covered -> good (no defensive used)', player: WITHIN_BAND, notReached: false, covered: false, status: 'good', icon: 'check_circle', note: 'no defensive used' },
    // At exactly the band edge is still good (strict boundary - only STRICTLY above is bad).
    { name: 'at band edge -> good', player: BAND_EDGE, notReached: false, covered: true, status: 'good', icon: 'check_circle', note: 'covered' },
    // Above the band -> bad, whether or not the defensive was pressed.
    { name: 'above band, covered -> bad (used wrongly)', player: ABOVE_BAND, notReached: false, covered: true, status: 'bad', icon: 'error', note: 'defensive used wrongly' },
    { name: 'above band, not covered -> bad (needed, unused)', player: ABOVE_BAND, notReached: false, covered: false, status: 'bad', icon: 'error', note: 'defensive needed, unused' },
  ])('$name', ({ player, notReached, covered, status, icon, note }) => {
    expect(defensiveWindowStatus(player, TOP_MAX, STDDEV, notReached, covered)).toEqual({ status, icon, note });
  });
});

describe('playerCoveredWindow', () => {
  const window = { time_s: 30, window_length_s: 5 } as BurstWindow;
  const withSpans = (spans: { start_s: number; end_s: number }[]): PlayerDefensive =>
    ({ name: 'Cloak of Shadows', uses: spans.length, windows: spans });

  it('is true when a player span overlaps the window plus slack', () => {
    expect(playerCoveredWindow(window, withSpans([{ start_s: 33, end_s: 38 }]))).toBe(true);
  });

  it('covers a span reaching the slack edge, not one just short of it', () => {
    // window [30,35], slack 3 -> covers [27,38]; a span ending at 27 reaches the edge.
    expect(playerCoveredWindow(window, withSpans([{ start_s: 10, end_s: 27 }]))).toBe(true);
    expect(playerCoveredWindow(window, withSpans([{ start_s: 10, end_s: 26 }]))).toBe(false);
  });

  it('is false with no player defensive', () => {
    expect(playerCoveredWindow(window, undefined)).toBe(false);
  });
});

describe('defensiveMapAnchor', () => {
  it('carries seek time and the dominant enemy game id', () => {
    const window = { time_s: 30, window_length_s: 5, defensive_name: 'Cloak of Shadows', spell_id: CLOAK_OF_SHADOWS, ref_game_id: 6666 } as BurstWindow;
    expect(defensiveMapAnchor(window)).toEqual({ timeS: 30, refGameId: 6666, windowLengthS: 5 });
  });

  it('falls back to a null ref when absent', () => {
    const window = { time_s: 5, window_length_s: 5 } as BurstWindow;
    expect(defensiveMapAnchor(window)).toEqual({ timeS: 5, refGameId: null, windowLengthS: 5 });
  });
});

describe('defensiveClipAnchor', () => {
  it('carries the window span and a stable indexed key', () => {
    const window = { time_s: 30, window_length_s: 5 } as BurstWindow;
    expect(defensiveClipAnchor(window, 1)).toEqual({ timeS: 30, windowLengthS: 5, key: 'defensive-1' });
  });
});

describe('defensiveFindingClipAnchor', () => {
  it('is a point anchor at the cast time, keyed by the exact second', () => {
    expect(defensiveFindingClipAnchor(30.2)).toEqual({ timeS: 30.2, windowLengthS: 0, key: 'defensive-find-30.2' });
  });

  it('keeps two findings within the same second on distinct clip keys', () => {
    expect(defensiveFindingClipAnchor(30.2).key).not.toBe(defensiveFindingClipAnchor(30.6).key);
  });
});

describe('buildDefensiveWindows', () => {
  const window: BurstWindow = {
    time_s: 30, window_length_s: 5, dmg_avg: 1000, dmg_min: 800, dmg_max: 1200, dmg_stddev: 100,
    defensive_name: 'Cloak of Shadows', spell_id: CLOAK_OF_SHADOWS, ref_game_id: 6666, common_cds: ['Cloak of Shadows'],
    ability_breakdown: [{ spell_id: 700, avg_damage: 600, min_damage: 400, max_damage: 800 }],
  };
  const abilities = { [CLOAK_OF_SHADOWS]: { icon: 'cloak', name: 'Cloak of Shadows' }, 700: { icon: 'hit', name: 'Boss Hit' } };

  it('pairs each window with player damage taken at the same index', () => {
    const player: PlayerBurstWindow[] = [{ window_damage: 1150, ability_breakdown: [{ spell_id: 700, damage: 700 }] }];
    // Covered the window (span 30-35); 1150 is within the band (max 1200 + stddev 100 = 1300) -> good, annotated covered.
    const playerDef: PlayerDefensive[] = [{ name: 'Cloak of Shadows', uses: 1, windows: [{ start_s: 30, end_s: 35 }] }];
    const { windows, anchors, clipAnchors } = buildDefensiveWindows({ topWindows: [window], playerWindows: player, playerDefensives: playerDef, fightDurationS: 300, abilities });
    assert.exists(windows[0]);
    expect(windows[0].overview.playerPct).toBe(1150);
    assert.exists(windows[0]);
    expect(windows[0].status).toBe('good');
    assert.exists(windows[0]);
    expect(windows[0].labels).toContain('covered');
    assert.exists(windows[0]);
    expect(windows[0].spells).toEqual([{ id: CLOAK_OF_SHADOWS, icon: 'cloak', name: 'Cloak of Shadows' }]);
    assert.exists(windows[0]);
    expect(windows[0].detailRows[0]).toMatchObject({ spellId: 700, label: 'Boss Hit', icon: 'hit', playerPct: 700, topAvg: 600 });
    expect(anchors[0]).toEqual({ timeS: 30, refGameId: 6666, windowLengthS: 5 });
    expect(clipAnchors[0]).toEqual({ timeS: 30, windowLengthS: 5, key: 'defensive-0' });
  });

  it('marks an above-band window bad, annotated as needing an unused defensive', () => {
    // 1500 > band edge (max 1200 + stddev 100 = 1300); no covering defensive -> bad.
    const player: PlayerBurstWindow[] = [{ window_damage: 1500, ability_breakdown: [] }];
    const { windows } = buildDefensiveWindows({ topWindows: [window], playerWindows: player, playerDefensives: [], fightDurationS: 300, abilities });
    assert.exists(windows[0]);
    expect(windows[0].status).toBe('bad');
    assert.exists(windows[0]);
    expect(windows[0].labels).toContain('defensive needed, unused');
  });

  it('keeps an uncovered within-band window good, annotated no defensive used', () => {
    // 900 is within the band; not pressing a defensive when damage stayed acceptable is not a miss.
    const player: PlayerBurstWindow[] = [{ window_damage: 900, ability_breakdown: [] }];
    const { windows } = buildDefensiveWindows({ topWindows: [window], playerWindows: player, playerDefensives: [], fightDurationS: 300, abilities });
    assert.exists(windows[0]);
    expect(windows[0].status).toBe('good');
    assert.exists(windows[0]);
    expect(windows[0].labels).toContain('no defensive used');
  });

  it('mutes and drops player data for a window the fight never reached', () => {
    const { windows } = buildDefensiveWindows({ topWindows: [window], playerWindows: [], playerDefensives: [], fightDurationS: 5, abilities });
    assert.exists(windows[0]);
    expect(windows[0].status).toBe('muted');
    assert.exists(windows[0]);
    expect(windows[0].overview.playerPct).toBeNull();
  });
});

describe('buildDefensivePlanRows', () => {
  function benchWith(overrides: Partial<DefensiveBench>): DefensiveBench {
    return {
      spec: 'SubtletyRogue', encounter_id: 1, encounter_name: 'Boss', sample_count: 5,
      per_defensive_benchmarks: {}, defensive_windows: [],
      defensives: [], cd_spell_ids: {}, ability_icons: {},
      ...overrides,
    };
  }

  it('returns [] when the bench is null or has no defensives', () => {
    expect(buildDefensivePlanRows(null)).toEqual([]);
    expect(buildDefensivePlanRows(benchWith({}))).toEqual([]);
  });

  it('builds plan rows with window times, typical uses and the adoption counts', () => {
    const bench = benchWith({
      defensives: [{ name: 'Cloak of Shadows', spell_id: CLOAK_OF_SHADOWS, cooldown: 120, usage_rule: 'Use it', talent_gated: false }],
      ability_icons: { [CLOAK_OF_SHADOWS]: { icon: 'cloak', name: 'Cloak of Shadows' } },
      per_defensive_benchmarks: {
        'Cloak of Shadows': defBench({ avg_first_cast_s: 12, avg_gap_s: null, stddev_gap_s: null, median_uses: 2, sample_count: 5, used_sample_count: 5 }),
      },
      defensive_windows: [{ time_s: 30, window_length_s: 5, dmg_avg: 0, dmg_min: 0, dmg_max: 0, dmg_stddev: 0, defensive_name: 'Cloak of Shadows', common_cds: ['Cloak of Shadows'], ability_breakdown: [] }],
    });
    const rows = buildDefensivePlanRows(bench);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: 'Cloak of Shadows', spellId: CLOAK_OF_SHADOWS, icon: 'cloak',
      // The adoption counts reaching the row are the raw sample counts, not a precomputed "5/5" string.
      typicalUses: 2, usedSampleCount: 5, sampleCount: 5,
      firstCastS: 12, windowsS: [30], rule: 'Use it',
    });
  });

  it('falls back to an empty icon for a defensive whose spell id is not in the ability map', () => {
    // CLOAK_OF_SHADOWS is intentionally absent from ability_icons, so the guarded lookup must not throw.
    const bench = benchWith({
      defensives: [{ name: 'Cloak of Shadows', spell_id: CLOAK_OF_SHADOWS, cooldown: 120, usage_rule: 'Use it', talent_gated: false }],
      ability_icons: {},
    });
    const rows = buildDefensivePlanRows(bench);
    assert.exists(rows[0]);
    expect(rows[0].spellId).toBe(CLOAK_OF_SHADOWS);
    assert.exists(rows[0]);
    expect(rows[0].icon).toBe('');
  });

  it('renders the empty state for typical uses when no top parse ever used the defensive', () => {
    const TOTAL_SAMPLED = 5;
    const bench = benchWith({
      defensives: [CLOAK_META],
      ability_icons: { [CLOAK_OF_SHADOWS]: { icon: 'cloak', name: 'Cloak of Shadows' } },
      per_defensive_benchmarks: {
        'Cloak of Shadows': defBench({ sample_count: TOTAL_SAMPLED, used_sample_count: 0, avg_first_cast_s: 0, median_uses: 0 }),
      },
    });
    const rows = buildDefensivePlanRows(bench);
    // No sampled parse ever used it, so the row renders the honest empty state rather than a 0.
    assert.exists(rows[0]);
    expect(rows[0].typicalUses).toBeNull();
    assert.exists(rows[0]);
    expect(rows[0].firstCastS).toBeNull();
    assert.exists(rows[0]);
    expect(rows[0].usedSampleCount).toBe(0);
    assert.exists(rows[0]);
    expect(rows[0].sampleCount).toBe(TOTAL_SAMPLED);
  });

  it('withholds first-cast when only a minority of top parses used the defensive (use-share gate)', () => {
    // 4/10 = 40%, below the 50% majority gate, so a real avg_first_cast_s is unrepresentative of the plan.
    const TOTAL_SAMPLED = 10;
    const MINORITY_USERS = 4;
    const MEDIAN_USES = 3;
    const bench = benchWith({
      defensives: [CLOAK_META],
      ability_icons: { [CLOAK_OF_SHADOWS]: { icon: 'cloak', name: 'Cloak of Shadows' } },
      per_defensive_benchmarks: {
        'Cloak of Shadows': defBench({ sample_count: TOTAL_SAMPLED, used_sample_count: MINORITY_USERS, avg_first_cast_s: 12, median_uses: MEDIAN_USES }),
      },
    });
    const rows = buildDefensivePlanRows(bench);
    assert.exists(rows[0]);
    expect(rows[0].firstCastS).toBeNull();
    // Typical uses only gates on any adoption at all, not the majority share, so a minority still surfaces it.
    assert.exists(rows[0]);
    expect(rows[0].typicalUses).toBe(MEDIAN_USES);
    assert.exists(rows[0]);
    expect(rows[0].usedSampleCount).toBe(MINORITY_USERS);
    assert.exists(rows[0]);
    expect(rows[0].sampleCount).toBe(TOTAL_SAMPLED);
  });

  it('shows first-cast exactly at the majority-share boundary', () => {
    // 5/10 = 50%, the inclusive boundary - matches the >= majority gate the rotation plan uses.
    const TOTAL_SAMPLED = 10;
    const MAJORITY_USERS = 5;
    const FIRST_CAST_S = 12;
    const bench = benchWith({
      defensives: [CLOAK_META],
      ability_icons: { [CLOAK_OF_SHADOWS]: { icon: 'cloak', name: 'Cloak of Shadows' } },
      per_defensive_benchmarks: {
        'Cloak of Shadows': defBench({ sample_count: TOTAL_SAMPLED, used_sample_count: MAJORITY_USERS, avg_first_cast_s: FIRST_CAST_S }),
      },
    });
    const rows = buildDefensivePlanRows(bench);
    assert.exists(rows[0]);
    expect(rows[0].firstCastS).toBe(FIRST_CAST_S);
  });
});

function fullBench(): DefensiveBench {
  return {
    spec: 'SubtletyRogue', encounter_id: 1, encounter_name: 'Boss', sample_count: 5,
    per_defensive_benchmarks: { 'Cloak of Shadows': defBench() },
    defensive_windows: [{
      time_s: 30, window_length_s: 5, dmg_avg: 1000, dmg_min: 800, dmg_max: 1200, dmg_stddev: 100,
      defensive_name: 'Cloak of Shadows', spell_id: CLOAK_OF_SHADOWS, ref_game_id: 6666, common_cds: ['Cloak of Shadows'],
      ability_breakdown: [{ spell_id: 700, avg_damage: 600, min_damage: 400, max_damage: 800 }],
    }],
    defensives: [CLOAK_META],
    cd_spell_ids: { 'Cloak of Shadows': CLOAK_OF_SHADOWS },
    ability_icons: { [CLOAK_OF_SHADOWS]: { icon: 'cloak', name: 'Cloak of Shadows' }, 700: { icon: 'hit', name: 'Boss Hit' } },
  };
}

function serviceWith(bench: Result<DefensiveBench>, wcl: Record<string, unknown> = {}): DefensiveFeatureService {
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
  it('propagates a non-ok bench unchanged (missing drives the waiting state)', async () => {
    const service = serviceWith(missing('Not yet ingested.'));
    const result = await service.loadAnalysisView('SubtletyRogue', 1, 'r1', 1, 10);
    expect(result).toEqual(missing('Not yet ingested.'));
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
        if (dataType === 'Buffs') return [applyBuff(CLOAK_OF_SHADOWS, 30), removeBuff(CLOAK_OF_SHADOWS, 35)];
        if (dataType === 'Casts') return [];
        return [damageTaken(700, 32, 1150)]; // DamageTaken inside window
      },
    };
    const service = serviceWith(ok(fullBench()), wcl);
    const result = await service.loadAnalysisView('SubtletyRogue', 1, 'r1', 1, 10);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.spellIdsByName).toEqual({ 'Cloak of Shadows': CLOAK_OF_SHADOWS });
    expect(result.value.iconByName).toEqual({ 'Cloak of Shadows': 'cloak' });
    expect(result.value.windows).toHaveLength(1);
    assert.exists(result.value.windows[0]);
    expect(result.value.windows[0].overview.playerPct).toBe(1150);
    expect(result.value.anchors[0]).toMatchObject({ refGameId: 6666 });
    // 1 use vs avg ~2, but only one buff window -> first cast at 30 (late) gives a warning finding.
    expect(result.value.findings.length).toBeGreaterThan(0);
  });

  it('does not throw and yields an empty icon when a cd spell id is missing from the ability map', async () => {
    const report = {
      title: 't',
      fights: [{ id: 1, name: 'Boss', startTime: 0, endTime: 300_000, kill: true, encounterID: 1, friendlyPlayers: [] }],
      masterData: { actors: [{ id: 10, name: 'P', subType: 'Rogue', server: '' }], abilities: [] },
    };
    const wcl = { getReport: async () => report, getAllEvents: async () => [] };
    // ability_icons intentionally omits CLOAK_OF_SHADOWS even though cd_spell_ids still references it.
    const bench = { ...fullBench(), ability_icons: {} };
    const service = serviceWith(ok(bench), wcl);
    const result = await service.loadAnalysisView('SubtletyRogue', 1, 'r1', 1, 10);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.iconByName).toEqual({ 'Cloak of Shadows': '' });
  });

  it('surfaces a WCL failure as an error instead of a silent bench-only view', async () => {
    const wcl = { getReport: async () => { throw new Error('WCL down'); } };
    const service = serviceWith(ok(fullBench()), wcl);
    const result = await service.loadAnalysisView('SubtletyRogue', 1, 'r1', 1, 10);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatchObject({ kind: 'permanent', id: 'defensive.player-view' });
  });

  it('returns an informational ok view when the selected fight is absent (e.g. mid live-sync)', async () => {
    const wcl = { getReport: async () => ({ title: 't', fights: [], masterData: { actors: [], abilities: [] } }) };
    const service = serviceWith(ok(fullBench()), wcl);
    const result = await service.loadAnalysisView('SubtletyRogue', 1, 'r1', 99, 10);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toMatchObject({ findings: [], windows: [], spellIdsByName: { 'Cloak of Shadows': CLOAK_OF_SHADOWS } });
  });
});

describe('DefensiveFeatureService.loadPlan (pre-fight)', () => {
  it('returns the bench-only plan rows', async () => {
    const service = serviceWith(ok(fullBench()));
    const result = await service.loadPlan('SubtletyRogue', 1);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.rows).toHaveLength(1);
      expect(result.value.rows[0]).toMatchObject({ name: 'Cloak of Shadows', spellId: CLOAK_OF_SHADOWS, typicalUses: 2, firstCastS: 10, windowsS: [30] });
    }
  });

  it('propagates a transient bench outage so the pre-fight plan surfaces a retry error', async () => {
    const service = serviceWith(transient('WCL is unreachable right now.'));
    expect(await service.loadPlan('SubtletyRogue', 1)).toEqual(transient('WCL is unreachable right now.'));
  });

  it('propagates a missing bench so the pre-fight plan waiting state shows', async () => {
    const service = serviceWith(missing('Not yet ingested.'));
    expect(await service.loadPlan('SubtletyRogue', 1)).toEqual(missing('Not yet ingested.'));
  });
});
