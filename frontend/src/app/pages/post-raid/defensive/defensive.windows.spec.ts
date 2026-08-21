import { assert, describe, it, expect } from 'vitest';
import { BurstWindow, PlayerBurstWindow, PlayerDefensive } from '../../../core/models/analysis.models';
import {
  computePlayerDefensiveWindows,
  defensiveWindowStatus, defensiveMapAnchor, defensiveClipAnchor, defensiveFindingClipAnchor, buildDefensiveWindows,
  defensiveDetailRows,
  playerCoveredWindow,
} from './defensive.service';
import { damageTaken } from '../../../../testing/builders/events';
import { CLOAK_OF_SHADOWS } from '../../../../testing/spell-ids';
import {
  WCL_MELEE_EVENT_ABILITY_ID, WOW_AUTO_ATTACK_SPELL_ID, WCL_SYNTHETIC_SOURCE_FALLBACK_ID,
} from '../../../shared/analysis/wcl-projections';
import { timed } from './defensive-harness';

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
    // 9001 is intentionally absent from the ability map, so the guarded lookup must not throw.
    const breakdown = [{ spell_id: 9001, avg_damage: 600, min_damage: 400, max_damage: 800, count: 5 }];
    const rows = defensiveDetailRows(breakdown, null, {});
    assert.exists(rows[0]);
    expect(rows[0].label).toBe('Ability #9001');
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
