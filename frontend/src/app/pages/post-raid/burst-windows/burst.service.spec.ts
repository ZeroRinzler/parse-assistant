import { assert, describe, it, expect } from 'vitest';
import { HttpErrorResponse } from '@angular/common/http';
import { BurstWindow, PlayerBurstWindow } from '../../../core/models/analysis.models';
import { Result, ok, missing } from '../../../core/result';
import { BURST_DATA_SOURCE, BurstBench } from './burst-data-source';
import { sliceService } from '../../../../testing/service-harness';
import {
  BurstFeatureService,
  burstWindowStatus, splitCommonCds, burstMapAnchor, burstClipAnchor, buildBurstView, burstDetailRows, findPlayerBurstWindows,
} from './burst.service';
import { wclReport } from '../../../../testing/builders/wcl-fixtures';
import {
  SHADOW_BLADES, SHADOW_BLADES_DAMAGE,
  WCL_MELEE_EVENT_ABILITY_ID, WOW_AUTO_ATTACK_SPELL_ID, WCL_SYNTHETIC_SOURCE_FALLBACK_ID,
} from '../../../../testing/spell-ids';
import { cast, damage } from '../../../../testing/builders/events';
import { withRelativeS } from '../../../shared/analysis/wcl-projections';

/** Fixture events build against a fight-start of 0, so stamping is a pass-through to seconds. */
const timed = withRelativeS;

function first<T>(items: readonly T[]): T {
  const [head] = items;
  assert.exists(head);
  return head;
}

// A melee auto-attack (event id 1) folds onto Auto Attack; synthetic negatives fold onto the "I Don't Know" fallback.
const MELEE_HIT = 300;
const SYNTHETIC_HIT = 100;
// Two distinct negative ids WCL synthesizes for sourceless events; both normalize to the fallback spell.
const PET_MELEE_ID = -32;
const ENVIRONMENTAL_ID = -7;

describe('burstWindowStatus', () => {
  // topAvg 1000, topMin 800, stddev 100 -> bad below 700, warn below 900.
  it.each([
    { name: 'not reached -> muted', player: 950, notReached: true, status: 'muted', icon: 'schedule' },
    { name: 'missing player data -> muted', player: null, notReached: false, status: 'muted', icon: 'help_outline' },
    { name: 'far below min -> bad', player: 650, notReached: false, status: 'bad', icon: 'error' },
    { name: 'below avg band -> warn', player: 850, notReached: false, status: 'warn', icon: 'warning_amber' },
    { name: 'within range -> good', player: 1000, notReached: false, status: 'good', icon: 'check_circle' },
    { name: 'at min band edge (700) -> warn, not bad (strict)', player: 700, notReached: false, status: 'warn', icon: 'warning_amber' },
    { name: 'at avg band edge (900) -> good, not warn (strict)', player: 900, notReached: false, status: 'good', icon: 'check_circle' },
  ])('$name', ({ player, notReached, status, icon }) => {
    expect(burstWindowStatus(player, 1000, 800, 100, notReached)).toEqual({ status, icon });
  });

  it('bench-only -> neutral info, overriding every other state', () => {
    // Even with no player data and "not reached", benchOnly forces the neutral info glyph.
    expect(burstWindowStatus(null, 1000, 800, 100, true, true)).toEqual({ status: 'info', icon: 'insights' });
    expect(burstWindowStatus(650, 1000, 800, 100, false, true)).toEqual({ status: 'info', icon: 'insights' });
  });
});

describe('splitCommonCds', () => {
  it('routes known names to spell ids and unknown names to labels', () => {
    expect(splitCommonCds(['Shadow Blades', 'Mystery'], { 'Shadow Blades': SHADOW_BLADES }))
      .toEqual({ spellIds: [SHADOW_BLADES], labels: ['Mystery'] });
  });

  it('is empty for no cds', () => {
    expect(splitCommonCds([], {})).toEqual({ spellIds: [], labels: [] });
  });
});

describe('burstMapAnchor', () => {
  it('carries the window seek time', () => {
    const window = { time_s: 12, window_length_s: 18, common_cds: ['Shadow Blades', 'Mystery'] } as BurstWindow;
    expect(burstMapAnchor(window)).toEqual({ timeS: 12, windowLengthS: 18 });
  });
});

describe('burstClipAnchor', () => {
  it('carries the window span and a stable indexed key', () => {
    const window = { time_s: 12, window_length_s: 18 } as BurstWindow;
    expect(burstClipAnchor(window, 2)).toEqual({ timeS: 12, windowLengthS: 18, key: 'burst-2' });
  });
});

describe('burstDetailRows', () => {
  it('labels an ability whose spell id is missing from the ability map with a placeholder and empty icon', () => {
    // SHADOW_BLADES_DAMAGE is intentionally left out of the ability map, so the guarded lookup must not throw.
    const breakdown = [{ spell_id: SHADOW_BLADES_DAMAGE, avg_damage: 600, min_damage: 400, max_damage: 800, count: 5, avg_casts: 2 }];
    const row = first(burstDetailRows(breakdown, null, {}));
    expect(row.label).toBe(`Ability #${SHADOW_BLADES_DAMAGE}`);
    expect(row.icon).toBe('');
  });

  it('joins the player normalized melee and synthetic damage onto the bench auto-attack and fallback rows', () => {
    const window: BurstWindow = {
      time_s: 10, window_length_s: 20, dmg_avg: 0, dmg_min: 0, dmg_max: 0, dmg_stddev: 0, common_cds: [], ability_breakdown: [],
    };
    const playerWindow = first(findPlayerBurstWindows(
      [window],
      timed([
        damage(WCL_MELEE_EVENT_ABILITY_ID, 12, MELEE_HIT),
        damage(WCL_MELEE_EVENT_ABILITY_ID, 15, MELEE_HIT),
        damage(PET_MELEE_ID, 13, SYNTHETIC_HIT),
      ], 0),
      [],
      new Map(),
    ));
    const benchBreakdown = [
      { spell_id: WOW_AUTO_ATTACK_SPELL_ID, avg_damage: 500, min_damage: 400, max_damage: 800, count: 5, avg_casts: 0 },
      { spell_id: WCL_SYNTHETIC_SOURCE_FALLBACK_ID, avg_damage: 200, min_damage: 100, max_damage: 300, count: 5, avg_casts: 0 },
    ];
    const abilities = {
      [WOW_AUTO_ATTACK_SPELL_ID]: { icon: 'aa', name: 'Auto Attack' },
      [WCL_SYNTHETIC_SOURCE_FALLBACK_ID]: { icon: 'idk', name: 'Synthetic' },
    };
    const rows = burstDetailRows(benchBreakdown, playerWindow, abilities);
    const melee = rows.find(row => row.spellId === WOW_AUTO_ATTACK_SPELL_ID);
    assert.exists(melee);
    expect(melee.playerPct).toBe(2 * MELEE_HIT);
    expect(melee.playerCasts).toBe(0);
    const synthetic = rows.find(row => row.spellId === WCL_SYNTHETIC_SOURCE_FALLBACK_ID);
    assert.exists(synthetic);
    expect(synthetic.playerPct).toBe(SYNTHETIC_HIT);
  });
});

describe('buildBurstView', () => {
  const window: BurstWindow = {
    time_s: 10, window_length_s: 20, dmg_avg: 1000, dmg_min: 800, dmg_max: 1200, dmg_stddev: 100,
    common_cds: ['Shadow Blades'],
    ability_breakdown: [
      { spell_id: SHADOW_BLADES_DAMAGE, avg_damage: 600, min_damage: 400, max_damage: 800, avg_casts: 2 },
    ],
  };
  const abilities = { [SHADOW_BLADES]: { icon: 'sb', name: 'Shadow Blades' }, [SHADOW_BLADES_DAMAGE]: { icon: 'evis', name: 'Eviscerate' } };

  it('pairs each window with the player damage at the same index', () => {
    const player: PlayerBurstWindow[] = [
      { window_damage: 950, ability_breakdown: [{ spell_id: SHADOW_BLADES_DAMAGE, damage: 550, casts: 2 }] },
    ];
    const view = buildBurstView([window], player, 300, { 'Shadow Blades': SHADOW_BLADES }, abilities);
    expect(view.windows).toHaveLength(1);
    const burstWindow = first(view.windows);
    expect(burstWindow.overview.playerPct).toBe(950);
    expect(burstWindow.spells).toEqual([{ id: SHADOW_BLADES, icon: 'sb', name: 'Shadow Blades' }]);
    expect(burstWindow.detailRows[0]).toMatchObject({ spellId: SHADOW_BLADES_DAMAGE, label: 'Eviscerate', icon: 'evis', playerPct: 550, topAvg: 600 });
    expect(view.anchors[0]).toEqual({ timeS: 10, windowLengthS: 20 });
    expect(view.clipAnchors[0]).toEqual({ timeS: 10, windowLengthS: 20, key: 'burst-0' });
  });

  it('flags a detail row passive when the bench ability is passive', () => {
    const passiveWindow: BurstWindow = {
      ...window,
      ability_breakdown: [
        { spell_id: SHADOW_BLADES_DAMAGE, avg_damage: 600, min_damage: 400, max_damage: 800, avg_casts: 0, is_passive: true },
      ],
    };
    const view = buildBurstView([passiveWindow], [], 300, {}, abilities, true);
    expect(first(first(view.windows).detailRows).passive).toBe(true);
    // The default (non-passive) bench ability stays passive=false.
    const benchWindow = first(buildBurstView([window], [], 300, {}, abilities, true).windows);
    expect(first(benchWindow.detailRows).passive).toBe(false);
  });

  it('mutes and drops player data for a window the fight never reached', () => {
    const burstWindow = first(buildBurstView([window], [], 5, {}, abilities).windows);
    expect(burstWindow.status).toBe('muted');
    expect(burstWindow.overview.playerPct).toBeNull();
  });

  it('bench-only marks windows neutral info (no player overlay) instead of muted', () => {
    const burstWindow = first(buildBurstView([window], [], Number.POSITIVE_INFINITY, {}, abilities, true).windows);
    expect(burstWindow.status).toBe('info');
    expect(burstWindow.statusIcon).toBe('insights');
    expect(burstWindow.overview.playerPct).toBeNull();
  });
});

describe('findPlayerBurstWindows', () => {
  const window: BurstWindow = {
    time_s: 10, window_length_s: 20, dmg_avg: 0, dmg_min: 0, dmg_max: 0, dmg_stddev: 0, common_cds: [], ability_breakdown: [],
  };

  it('sums player damage inside the window (amount + absorbed) and counts casts by ability name', () => {
    const out = findPlayerBurstWindows(
      [window],
      timed([damage(SHADOW_BLADES_DAMAGE, 12, 500, { absorbed: 100 }), damage(SHADOW_BLADES_DAMAGE, 15, 400), damage(1, 999, 5000)], 0),
      timed([cast(SHADOW_BLADES, 11), cast(SHADOW_BLADES, 13)], 0),
      // Bridge the damage id and the cast id to one name so the damage row counts the casts by NAME, not id.
      new Map([[SHADOW_BLADES_DAMAGE, 'Shadow Blades'], [SHADOW_BLADES, 'Shadow Blades']]),
    );
    // (500 + 100 absorbed) + 400 = 1000; the id-1 hit at 999s is outside the [10, 30) window.
    const playerWindow = first(out);
    expect(playerWindow.window_damage).toBe(1000);
    assert.exists(playerWindow.ability_breakdown);
    expect(playerWindow.ability_breakdown[0]).toMatchObject({ spell_id: SHADOW_BLADES_DAMAGE, damage: 1000, casts: 2 });
  });

  it('folds synthetic damage ids onto their normalized spells, summing raw ids that collapse together', () => {
    const out = findPlayerBurstWindows(
      [window],
      timed([
        damage(WCL_MELEE_EVENT_ABILITY_ID, 12, MELEE_HIT),
        damage(WCL_MELEE_EVENT_ABILITY_ID, 15, MELEE_HIT),
        damage(PET_MELEE_ID, 13, SYNTHETIC_HIT),
        damage(ENVIRONMENTAL_ID, 16, SYNTHETIC_HIT),
      ], 0),
      [],
      new Map(),
    );
    const breakdown = first(out).ability_breakdown;
    assert.exists(breakdown);
    expect(breakdown.find(row => row.spell_id === WOW_AUTO_ATTACK_SPELL_ID)?.damage).toBe(2 * MELEE_HIT);
    expect(breakdown.find(row => row.spell_id === WCL_SYNTHETIC_SOURCE_FALLBACK_ID)?.damage).toBe(2 * SYNTHETIC_HIT);
    // No raw synthetic id survives as its own row.
    expect(breakdown.some(row => row.spell_id === WCL_MELEE_EVENT_ABILITY_ID || row.spell_id < 0)).toBe(false);
  });

  it('excludes an event at exactly the window end (half-open)', () => {
    const out = findPlayerBurstWindows([window], timed([damage(SHADOW_BLADES_DAMAGE, 30, 800)], 0), [], new Map());
    expect(first(out).window_damage).toBe(0);
  });

  it('keeps a low-ranked ability the player used so the bench join surfaces its damage', () => {
    const FILLER_COUNT = 10;
    const FILLER_BASE_ID = 900_000; // synthetic ids distinct from the bench ability
    const FILLER_DAMAGE = 1_000; // each filler out-damages the bench hit, ranking it last
    const BENCH_HIT_DAMAGE = 50; // the player's damage on the bench ability, ranked past the filler abilities
    const AT_S = 15; // inside the [10, 30) window
    const fillerHits = Array.from({ length: FILLER_COUNT }, (_, i) => damage(FILLER_BASE_ID + i, AT_S, FILLER_DAMAGE));
    const out = findPlayerBurstWindows(
      [window],
      timed([...fillerHits, damage(SHADOW_BLADES_DAMAGE, AT_S, BENCH_HIT_DAMAGE)], 0),
      [],
      new Map([[SHADOW_BLADES_DAMAGE, 'Eviscerate']]),
    );
    const benchBreakdown = [{ spell_id: SHADOW_BLADES_DAMAGE, avg_damage: 600, min_damage: 400, max_damage: 800, count: 5, avg_casts: 2 }];
    const rows = burstDetailRows(benchBreakdown, first(out), { [SHADOW_BLADES_DAMAGE]: { icon: 'evis', name: 'Eviscerate' } });
    expect(first(rows).playerPct).toBe(BENCH_HIT_DAMAGE);
  });
});

const wclFake = {
  getReport: async () => wclReport({
    actors: [], abilities: [{ gameID: SHADOW_BLADES_DAMAGE, name: 'Eviscerate', icon: 'inv' }],
  }),
  getAllEvents: async (_code: string, _fightId: number, dataType: string) =>
    dataType === 'Casts' ? [cast(SHADOW_BLADES, 11)] : [damage(SHADOW_BLADES_DAMAGE, 12, 950)],
};

function withBench(bench: Result<BurstBench>, wcl: unknown = wclFake): BurstFeatureService {
  return sliceService(BURST_DATA_SOURCE, BurstFeatureService, bench, wcl);
}

const benchFixture: BurstBench = {
  spec: 'SubtletyRogue', encounter_id: 1, encounter_name: 'Test', sample_count: 5,
  cd_spell_ids: { 'Shadow Blades': SHADOW_BLADES },
  ability_icons: { [SHADOW_BLADES]: { icon: 'sb', name: 'Shadow Blades' }, [SHADOW_BLADES_DAMAGE]: { icon: 'evis', name: 'Eviscerate' } },
  windows: [{
    time_s: 10, window_length_s: 20, dmg_avg: 1000, dmg_min: 800, dmg_max: 1200, dmg_stddev: 100,
    common_cds: ['Shadow Blades'],
    ability_breakdown: [{ spell_id: SHADOW_BLADES_DAMAGE, avg_damage: 600, min_damage: 400, max_damage: 800, avg_casts: 2 }],
  }],
};

// A 5xx status toLoadError maps to a transient error.
const HTTP_SERVICE_UNAVAILABLE = 503;

describe('BurstFeatureService', () => {
  it('propagates the data-source error when the bench read fails', async () => {
    const result = await withBench(missing('Not yet ingested.')).loadBenchView('SubtletyRogue', 1);
    expect(result).toEqual(missing('Not yet ingested.'));
  });

  it('returns an ok bench view when the bench file exists', async () => {
    const result = await withBench(ok(benchFixture)).loadBenchView('SubtletyRogue', 1);
    expect(result.ok).toBe(true);
  });

  it('bench-only: shows the top windows with no player overlay (neutral info status)', async () => {
    const result = await withBench(ok(benchFixture)).loadBenchView('SubtletyRogue', 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.windows).toHaveLength(1);
    const burstWindow = first(result.value.windows);
    expect(burstWindow.overview.playerPct).toBeNull();
    expect(burstWindow.status).toBe('info');
    expect(burstWindow.statusIcon).toBe('insights');
    expect(result.value.anchors[0]).toEqual({ timeS: 10, windowLengthS: 20 });
  });

  it('player view: fetches the log and compares the player damage against the bench', async () => {
    const result = await withBench(ok(benchFixture)).loadPlayerView('SubtletyRogue', 1, 'rep', 1, 10);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.windows).toHaveLength(1);
    const burstWindow = first(result.value.windows);
    expect(burstWindow.overview.playerPct).toBe(950);
    expect(first(burstWindow.detailRows).label).toBe('Eviscerate');
    expect(result.value.anchors[0]).toEqual({ timeS: 10, windowLengthS: 20 });
  });

  it('surfaces a WCL failure in the player view as a transient error (no silent bench-only fallback)', async () => {
    const failingWcl = { getReport: async () => { throw new HttpErrorResponse({ status: HTTP_SERVICE_UNAVAILABLE }); } };
    const result = await withBench(ok(benchFixture), failingWcl).loadPlayerView('SubtletyRogue', 1, 'rep', 1, 10);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('transient');
  });

  it('returns an ok informational view when the selected fight is not in the report (live sync)', async () => {
    const MISSING_FIGHT_ID = 999;
    const result = await withBench(ok(benchFixture)).loadPlayerView('SubtletyRogue', 1, 'rep', MISSING_FIGHT_ID, 10);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.windows).toHaveLength(1);
    // No player overlay: the informational bench-only view (benchOnly=true) shows the neutral info glyph.
    const burstWindow = first(result.value.windows);
    expect(burstWindow.status).toBe('info');
    expect(burstWindow.overview.playerPct).toBeNull();
  });
});
