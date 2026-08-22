import { assert, describe, it, expect } from 'vitest';
import { BurstWindow, PlayerBurstWindow, PlayerDefensive } from '../../../core/models/analysis.models';
import {
  computePlayerDefensiveWindows,
  defensiveWindowStatus, defensiveMapAnchor, defensiveClipAnchor, defensiveFindingClipAnchor, buildDefensiveWindows,
  playerCoveredWindow,
} from './defensive.service';
import { damageTaken } from '../../../../testing/builders/events';
import { CLOAK_OF_SHADOWS } from '../../../../testing/spell-ids';
import { BOSS_HIT_SPELL_ID, timed } from './defensive-harness';

function first<T>(items: readonly T[]): T {
  const [head] = items;
  assert.exists(head);
  return head;
}

describe('computePlayerDefensiveWindows', () => {
  const WIN_START_S = 10;
  const WIN_LEN_S = 5;
  const top: BurstWindow[] = [
    { time_s: WIN_START_S, window_length_s: WIN_LEN_S, dmg_avg: 0, dmg_min: 0, dmg_max: 0, dmg_stddev: 0, common_cds: [], ability_breakdown: [] },
  ];

  it('sums the damage the player took in the window, with no cast count to report', () => {
    const AMOUNT = 400, ABSORBED = 150;
    const SECOND_SOURCE_ID = BOSS_HIT_SPELL_ID + 1, SECOND_HIT = 100;
    const out = computePlayerDefensiveWindows(top, timed([
      damageTaken(BOSS_HIT_SPELL_ID, WIN_START_S + 2, AMOUNT, { absorbed: ABSORBED }),
      damageTaken(SECOND_SOURCE_ID, WIN_START_S + 4, SECOND_HIT),
    ], 0));
    expect(first(out).window_damage).toBe(AMOUNT + ABSORBED + SECOND_HIT);
    const breakdown = first(out).ability_breakdown;
    assert.exists(breakdown);
    expect(first(breakdown)).toEqual({ spell_id: BOSS_HIT_SPELL_ID, damage: AMOUNT + ABSORBED });
  });

  it('lists the six heaviest damage sources and drops the rest', () => {
    const SOURCE_COUNT = 8;
    const KEPT_SOURCES = 6;
    const PER_SOURCE_DAMAGE = 100;
    const hits = Array.from({ length: SOURCE_COUNT }, (_, i) =>
      damageTaken(BOSS_HIT_SPELL_ID + i, WIN_START_S + 1, (i + 1) * PER_SOURCE_DAMAGE));
    const breakdown = first(computePlayerDefensiveWindows(top, timed(hits, 0))).ability_breakdown;
    assert.exists(breakdown);
    expect(breakdown).toHaveLength(KEPT_SOURCES);
    expect(first(breakdown).damage).toBe(SOURCE_COUNT * PER_SOURCE_DAMAGE);
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
    ability_breakdown: [{ spell_id: BOSS_HIT_SPELL_ID, avg_damage: 600, min_damage: 400, max_damage: 800 }],
  };
  const abilities = {
    [CLOAK_OF_SHADOWS]: { icon: 'cloak', name: 'Cloak of Shadows' },
    [BOSS_HIT_SPELL_ID]: { icon: 'hit', name: 'Boss Hit' },
  };
  const FIGHT_DURATION_S = 300;

  it('pairs each window with player damage taken at the same index', () => {
    const player: PlayerBurstWindow[] = [{ window_damage: 1150, ability_breakdown: [{ spell_id: BOSS_HIT_SPELL_ID, damage: 700 }] }];
    // Covered the window (span 30-35); 1150 is within the band (max 1200 + stddev 100 = 1300) -> good, annotated covered.
    const playerDef: PlayerDefensive[] = [{ name: 'Cloak of Shadows', uses: 1, windows: [{ start_s: 30, end_s: 35 }] }];
    const { windows, anchors, clipAnchors } = buildDefensiveWindows({ topWindows: [window], playerWindows: player, playerDefensives: playerDef, fightDurationS: FIGHT_DURATION_S, abilities });
    const defensiveWindow = first(windows);
    expect(defensiveWindow.overview.playerPct).toBe(1150);
    expect(defensiveWindow.status).toBe('good');
    expect(defensiveWindow.labels).toContain('covered');
    expect(defensiveWindow.spells).toEqual([{ id: CLOAK_OF_SHADOWS, icon: 'cloak', name: 'Cloak of Shadows' }]);
    expect(first(defensiveWindow.detailRows)).toMatchObject({ spellId: BOSS_HIT_SPELL_ID, label: 'Boss Hit', icon: 'hit', playerPct: 700, topAvg: 600 });
    expect(anchors[0]).toEqual({ timeS: 30, refGameId: 6666, windowLengthS: 5 });
    expect(clipAnchors[0]).toEqual({ timeS: 30, windowLengthS: 5, key: 'defensive-0' });
  });

  it('names the defensive as a plain label when the bench window has no spell id', () => {
    const unbakedWindow: BurstWindow = { ...window, spell_id: undefined };
    const { windows } = buildDefensiveWindows({ topWindows: [unbakedWindow], playerWindows: [], playerDefensives: [], fightDurationS: FIGHT_DURATION_S, abilities });
    expect(first(windows).spells).toEqual([]);
    expect(first(windows).labels).toContain('Cloak of Shadows');
  });

  it('marks an above-band window bad, annotated as needing an unused defensive', () => {
    // 1500 > band edge (max 1200 + stddev 100 = 1300); no covering defensive -> bad.
    const player: PlayerBurstWindow[] = [{ window_damage: 1500, ability_breakdown: [] }];
    const { windows } = buildDefensiveWindows({ topWindows: [window], playerWindows: player, playerDefensives: [], fightDurationS: FIGHT_DURATION_S, abilities });
    expect(first(windows).status).toBe('bad');
    expect(first(windows).labels).toContain('defensive needed, unused');
  });

  it('keeps an uncovered within-band window good, annotated no defensive used', () => {
    // 900 is within the band; not pressing a defensive when damage stayed acceptable is not a miss.
    const player: PlayerBurstWindow[] = [{ window_damage: 900, ability_breakdown: [] }];
    const { windows } = buildDefensiveWindows({ topWindows: [window], playerWindows: player, playerDefensives: [], fightDurationS: FIGHT_DURATION_S, abilities });
    expect(first(windows).status).toBe('good');
    expect(first(windows).labels).toContain('no defensive used');
  });
});
