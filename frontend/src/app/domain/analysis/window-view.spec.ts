import { assert, describe, it, expect } from 'vitest';
import { BurstWindow, PlayerBurstWindow } from './analysis.models';
import { RangeRow } from './window-comparison.models';
import { AbilityIcons, WclProjectionsService } from './wcl-projections-service';
import { WindowView, WindowViewAdapter, WindowViewService } from './window-view-service';
import { cast, damage } from '../../../testing/builders/events';
import {
  SHADOW_BLADES, SHADOW_BLADES_DAMAGE,
  WCL_MELEE_EVENT_ABILITY_ID, WOW_AUTO_ATTACK_SPELL_ID, WCL_SYNTHETIC_SOURCE_FALLBACK_ID,
} from '../../../testing/spell-ids';
import { TestBed } from '@angular/core/testing';

const wclProjections = TestBed.inject(WclProjectionsService);
const windowView = TestBed.inject(WindowViewService);

/** Fixture events build against a fight-start of 0, so stamping is a pass-through to seconds. */
const timed: WclProjectionsService['withRelativeS'] = (events, startMs) => wclProjections.withRelativeS(events, startMs);

function first<T>(items: readonly T[]): T {
  const [head] = items;
  assert.exists(head);
  return head;
}

const WINDOW_START_S = 10;
const WINDOW_LENGTH_S = 20;
const WINDOW_END_S = WINDOW_START_S + WINDOW_LENGTH_S;
const FIGHT_DURATION_S = 300;

const TOP_AVG = 1000, TOP_MIN = 800, TOP_MAX = 1200, TOP_STDDEV = 100;

function topWindow(over: Partial<BurstWindow> = {}): BurstWindow {
  return {
    time_s: WINDOW_START_S, window_length_s: WINDOW_LENGTH_S,
    dmg_avg: TOP_AVG, dmg_min: TOP_MIN, dmg_max: TOP_MAX, dmg_stddev: TOP_STDDEV,
    common_cds: [], ability_breakdown: [],
    ...over,
  };
}

const ABILITIES: AbilityIcons = {
  [SHADOW_BLADES]: { icon: 'sb', name: 'Shadow Blades' },
  [SHADOW_BLADES_DAMAGE]: { icon: 'evis', name: 'Eviscerate' },
};

interface ProbeAnchor {
  timeS: number;
}

// Wording distinct from every slice's, so each assertion proves the value came from the adapter and not from the builder.
const PROBE_STATUS = { status: 'good', icon: 'probe_reached' } as const;
const PROBE_NOT_REACHED = { status: 'muted', icon: 'probe_past_end' } as const;

function probeAdapter(over: Partial<WindowViewAdapter<ProbeAnchor>> = {}): WindowViewAdapter<ProbeAnchor> {
  return {
    status: (_window, _playerDamage, notReached) => notReached ? PROBE_NOT_REACHED : PROBE_STATUS,
    chips: () => ({ spellIds: [], labels: [] }),
    mapAnchor: window => ({ timeS: window.time_s }),
    clipAnchor: (window, index) => ({ timeS: window.time_s, windowLengthS: window.window_length_s, key: `probe-${index}` }),
    ...over,
  };
}

const VIEW_INPUT = {
  topWindows: [topWindow()],
  playerWindows: [] as PlayerBurstWindow[],
  fightDurationS: FIGHT_DURATION_S,
  abilities: ABILITIES,
  adapter: probeAdapter(),
};

function viewOf(over: Partial<typeof VIEW_INPUT> = {}): WindowView<ProbeAnchor> {
  return windowView.buildWindowView({ ...VIEW_INPUT, ...over });
}

const detailRowsOf = (over: Partial<typeof VIEW_INPUT> = {}): RangeRow[] =>
  first(viewOf(over).windows).detailRows;

const PLAYER_DAMAGE = 950;
const playerWindow = (windowDamage: number): PlayerBurstWindow => ({ window_damage: windowDamage, ability_breakdown: [] });

describe('buildWindowView', () => {
  it('pairs each top window with the player window at the same index', () => {
    const SECOND_START_S = 90;
    const SECOND_DAMAGE = 4321;
    const { windows } = viewOf({
      topWindows: [topWindow(), topWindow({ time_s: SECOND_START_S })],
      playerWindows: [playerWindow(PLAYER_DAMAGE), playerWindow(SECOND_DAMAGE)],
    });
    expect(windows.map(window => window.overview.playerPct)).toEqual([PLAYER_DAMAGE, SECOND_DAMAGE]);
  });

  it('leaves the player damage null where the aggregation has no window at that index', () => {
    const { windows } = viewOf({
      topWindows: [topWindow(), topWindow({ time_s: 90 })],
      playerWindows: [playerWindow(PLAYER_DAMAGE)],
    });
    expect(windows.map(window => window.overview.playerPct)).toEqual([PLAYER_DAMAGE, null]);
  });

  it('reaches a window starting exactly at the fight end', () => {
    const { windows } = viewOf({ playerWindows: [playerWindow(PLAYER_DAMAGE)], fightDurationS: WINDOW_START_S });
    expect(first(windows).overview.playerPct).toBe(PLAYER_DAMAGE);
    expect(first(windows).statusIcon).toBe(PROBE_STATUS.icon);
  });

  it('does not reach a window starting one second past the fight end, and drops its player damage', () => {
    const ONE_SECOND_SHORT_S = WINDOW_START_S - 1;
    const { windows } = viewOf({ playerWindows: [playerWindow(PLAYER_DAMAGE)], fightDurationS: ONE_SECOND_SHORT_S });
    expect(first(windows).overview.playerPct).toBeNull();
    expect(first(windows).statusIcon).toBe(PROBE_NOT_REACHED.icon);
  });

  it('reaches every window when the caller passes no player windows and an unbounded fight', () => {
    const LATE_START_S = 9_999;
    const { windows } = viewOf({ topWindows: [topWindow({ time_s: LATE_START_S })], fightDurationS: Number.POSITIVE_INFINITY });
    expect(first(windows).statusIcon).toBe(PROBE_STATUS.icon);
    expect(first(windows).overview.playerPct).toBeNull();
  });

  it('spans the window and carries the top-parse band into the overview row', () => {
    const { windows } = viewOf({ playerWindows: [playerWindow(PLAYER_DAMAGE)] });
    expect(first(windows)).toMatchObject({ timeStartS: WINDOW_START_S, timeEndS: WINDOW_END_S });
    expect(first(windows).overview).toEqual({
      label: '', icon: '', playerPct: PLAYER_DAMAGE, topAvg: TOP_AVG, topMin: TOP_MIN, topMax: TOP_MAX,
    });
  });

  it('resolves the adapter spell ids to icon chips and keeps its plain labels', () => {
    const { windows } = viewOf({ adapter: probeAdapter({ chips: () => ({ spellIds: [SHADOW_BLADES], labels: ['Trinket'] }) }) });
    expect(first(windows).spells).toEqual([{ id: SHADOW_BLADES, icon: 'sb', name: 'Shadow Blades' }]);
    expect(first(windows).labels).toEqual(['Trinket']);
  });

  it('appends a status note after the adapter labels', () => {
    const NOTE = 'probe note';
    const { windows } = viewOf({
      adapter: probeAdapter({
        chips: () => ({ spellIds: [], labels: ['Trinket'] }),
        status: () => ({ ...PROBE_STATUS, note: NOTE }),
      }),
    });
    expect(first(windows).labels).toEqual(['Trinket', NOTE]);
  });

  it('appends nothing when the status carries an empty note', () => {
    const { windows } = viewOf({
      adapter: probeAdapter({
        chips: () => ({ spellIds: [], labels: ['Trinket'] }),
        status: () => ({ ...PROBE_STATUS, note: '' }),
      }),
    });
    expect(first(windows).labels).toEqual(['Trinket']);
  });

  it('collects one map anchor and one index-keyed clip anchor per window', () => {
    const SECOND_START_S = 90;
    const { anchors, clipAnchors } = viewOf({ topWindows: [topWindow(), topWindow({ time_s: SECOND_START_S })] });
    expect(anchors).toEqual([{ timeS: WINDOW_START_S }, { timeS: SECOND_START_S }]);
    expect(clipAnchors.map(anchor => anchor.key)).toEqual(['probe-0', 'probe-1']);
  });
});

const BENCH_AVG = 600, BENCH_MIN = 400, BENCH_MAX = 800, BENCH_CASTS = 2;
const PLAYER_ABILITY_DAMAGE = 550;

const benchBreakdown = (over: Partial<BurstWindow['ability_breakdown'][number]> = {}): BurstWindow['ability_breakdown'] =>
  [{ spell_id: SHADOW_BLADES_DAMAGE, avg_damage: BENCH_AVG, min_damage: BENCH_MIN, max_damage: BENCH_MAX, ...over }];

const benchWindow = (over: Partial<BurstWindow['ability_breakdown'][number]> = {}): BurstWindow[] =>
  [topWindow({ ability_breakdown: benchBreakdown(over) })];

const playerBreakdown = (casts?: number): PlayerBurstWindow[] => [{
  window_damage: PLAYER_DAMAGE,
  ability_breakdown: [{ spell_id: SHADOW_BLADES_DAMAGE, damage: PLAYER_ABILITY_DAMAGE, ...(casts == null ? {} : { casts }) }],
}];

describe('buildWindowView detail rows', () => {
  it('joins the player damage onto the bench row sharing its spell id', () => {
    expect(first(detailRowsOf({ topWindows: benchWindow(), playerWindows: playerBreakdown() }))).toEqual({
      spellId: SHADOW_BLADES_DAMAGE, label: 'Eviscerate', icon: 'evis',
      playerPct: PLAYER_ABILITY_DAMAGE, topAvg: BENCH_AVG, topMin: BENCH_MIN, topMax: BENCH_MAX,
    });
  });

  it('labels an ability the map is missing with a placeholder and no icon', () => {
    const row = first(detailRowsOf({ topWindows: benchWindow(), abilities: {} }));
    expect(row.label).toBe(`Ability #${SHADOW_BLADES_DAMAGE}`);
    expect(row.icon).toBe('');
    expect(row.playerPct).toBeNull();
  });

  it('carries the cast columns and the passive tag for a slice that asks for them', () => {
    const row = first(detailRowsOf({
      topWindows: benchWindow({ avg_casts: BENCH_CASTS, is_passive: true }),
      playerWindows: playerBreakdown(BENCH_CASTS),
      adapter: probeAdapter({ castColumns: true }),
    }));
    expect(row).toMatchObject({ playerCasts: BENCH_CASTS, topCasts: BENCH_CASTS, passive: true });
  });

  it('omits the cast columns entirely for a slice that does not', () => {
    const row = first(detailRowsOf({ topWindows: benchWindow({ avg_casts: BENCH_CASTS, is_passive: true }) }));
    expect(row.playerCasts).toBeUndefined();
    expect(row.topCasts).toBeUndefined();
    expect(row.passive).toBeUndefined();
  });
});

const HIT_S = WINDOW_START_S + 5;
const BIG_HIT = 900, SMALL_HIT = 100;
// Two of the distinct negative ids WCL synthesizes for sourceless events; both normalize to the one fallback spell.
const PET_MELEE_ID = -32, ENVIRONMENTAL_ID = -45;

describe('playerWindowDamage', () => {
  it('sums amount and absorbed inside the window', () => {
    const ABSORBED = 100;
    const out = windowView.playerWindowDamage([topWindow()], timed([damage(SHADOW_BLADES_DAMAGE, HIT_S, BIG_HIT, { absorbed: ABSORBED })], 0));
    expect(first(out).window_damage).toBe(BIG_HIT + ABSORBED);
  });

  it('counts a hit at the window start and excludes one at the window end', () => {
    const atStart = windowView.playerWindowDamage([topWindow()], timed([damage(SHADOW_BLADES_DAMAGE, WINDOW_START_S, BIG_HIT)], 0));
    expect(first(atStart).window_damage).toBe(BIG_HIT);
    const atEnd = windowView.playerWindowDamage([topWindow()], timed([damage(SHADOW_BLADES_DAMAGE, WINDOW_END_S, BIG_HIT)], 0));
    expect(first(atEnd).window_damage).toBe(0);
  });

  it('drops pre-pull hits and zero-damage events', () => {
    const PRE_PULL_S = -1;
    const out = windowView.playerWindowDamage([topWindow({ time_s: PRE_PULL_S })], timed([
      damage(SHADOW_BLADES_DAMAGE, PRE_PULL_S, BIG_HIT),
      damage(SHADOW_BLADES_DAMAGE, HIT_S, 0),
    ], 0));
    expect(first(out).window_damage).toBe(0);
  });

  it('folds melee and synthetic ability ids onto the normalized spells the bench breakdown keys on', () => {
    const out = windowView.playerWindowDamage([topWindow()], timed([
      damage(WCL_MELEE_EVENT_ABILITY_ID, HIT_S, BIG_HIT),
      damage(PET_MELEE_ID, HIT_S, SMALL_HIT),
      damage(ENVIRONMENTAL_ID, HIT_S, SMALL_HIT),
    ], 0));
    const breakdown = first(out).ability_breakdown;
    assert.exists(breakdown);
    expect(breakdown).toContainEqual({ spell_id: WOW_AUTO_ATTACK_SPELL_ID, damage: BIG_HIT });
    expect(breakdown).toContainEqual({ spell_id: WCL_SYNTHETIC_SOURCE_FALLBACK_ID, damage: 2 * SMALL_HIT });
  });

  it('ranks the breakdown by damage, biggest first, and keeps every ability when uncapped', () => {
    const out = windowView.playerWindowDamage([topWindow()], timed([
      damage(SHADOW_BLADES_DAMAGE, HIT_S, SMALL_HIT),
      damage(SHADOW_BLADES, HIT_S, BIG_HIT),
    ], 0));
    const breakdown = first(out).ability_breakdown;
    assert.exists(breakdown);
    expect(breakdown.map(row => row.spell_id)).toEqual([SHADOW_BLADES, SHADOW_BLADES_DAMAGE]);
  });

  it('keeps only the biggest rows once a cap is set', () => {
    const KEPT = 1;
    const out = windowView.playerWindowDamage([topWindow()], timed([
      damage(SHADOW_BLADES_DAMAGE, HIT_S, SMALL_HIT),
      damage(SHADOW_BLADES, HIT_S, BIG_HIT),
    ], 0), { maxAbilities: KEPT });
    const breakdown = first(out).ability_breakdown;
    assert.exists(breakdown);
    expect(breakdown.map(row => row.spell_id)).toEqual([SHADOW_BLADES]);
  });

  it('counts casts by ability name, bridging a damage id to the cast id sharing that name', () => {
    const CAST_COUNT = 2;
    const names = new Map([[SHADOW_BLADES_DAMAGE, 'Shadow Blades'], [SHADOW_BLADES, 'Shadow Blades']]);
    const out = windowView.playerWindowDamage([topWindow()], timed([damage(SHADOW_BLADES_DAMAGE, HIT_S, BIG_HIT)], 0), {
      attribution: {
        casts: timed([cast(SHADOW_BLADES, WINDOW_START_S + 1), cast(SHADOW_BLADES, HIT_S), cast(SHADOW_BLADES, WINDOW_END_S)], 0),
        nameOf: spellId => names.get(spellId) ?? '',
      },
    });
    const breakdown = first(out).ability_breakdown;
    assert.exists(breakdown);
    // The third cast sits at the window end, which the half-open window excludes.
    expect(first(breakdown)).toEqual({ spell_id: SHADOW_BLADES_DAMAGE, damage: BIG_HIT, casts: CAST_COUNT });
  });

  it('omits the cast count when the caller asks for no attribution', () => {
    const out = windowView.playerWindowDamage([topWindow()], timed([damage(SHADOW_BLADES_DAMAGE, HIT_S, BIG_HIT)], 0));
    const breakdown = first(out).ability_breakdown;
    assert.exists(breakdown);
    expect(first(breakdown)).toEqual({ spell_id: SHADOW_BLADES_DAMAGE, damage: BIG_HIT });
  });
});
