import { assert, describe, it, expect } from 'vitest';
import { BurstWindow, PlayerBurstWindow } from '../../../../domain/analysis/analysis.models';
import { Result, Results } from '../../../../core/http/result';
import { BURST_DATA_SOURCE, BurstBench } from '../data-access/burst-data-source';
import { sliceService } from '../../../../../testing/service-harness';
import { BurstFeatureService } from './burst-feature-service';
import { wclReport } from '../../../../../testing/builders/wcl-fixtures';
import { SHADOW_BLADES, SHADOW_BLADES_DAMAGE } from '../../../../../testing/spell-ids';
import { cast, damage } from '../../../../../testing/builders/events';
import { WclProjectionsService } from '../../../../domain/analysis/wcl-projections-service';
import { TestBed } from '@angular/core/testing';
import { WCL_TRANSPORT } from '../../../../core/wcl/wcl-transport';
import { DATA_FILE_TRANSPORT } from '../../../../core/data-files/data-file-transport';

const wclProjections = TestBed.inject(WclProjectionsService);
TestBed.resetTestingModule();
TestBed.configureTestingModule({ providers: [
  { provide: WCL_TRANSPORT, useValue: {} },
  { provide: DATA_FILE_TRANSPORT, useValue: { readJson: () => new Promise(() => undefined) } },
  { provide: BURST_DATA_SOURCE, useValue: {} },
] });
const svc = TestBed.inject(BurstFeatureService);
TestBed.resetTestingModule();

/** Fixture events build against a fight-start of 0, so stamping is a pass-through to seconds. */
const timed: WclProjectionsService['withRelativeS'] = (events, startMs) => wclProjections.withRelativeS(events, startMs);

function first<T>(items: readonly T[]): T {
  const [head] = items;
  assert.exists(head);
  return head;
}

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
    expect(svc['burstWindowStatus'](player, 1000, 800, 100, notReached)).toEqual({ status, icon });
  });

  it('bench-only -> neutral info, overriding every other state', () => {
    // Even with no player data and "not reached", benchOnly forces the neutral info glyph.
    expect(svc['burstWindowStatus'](null, 1000, 800, 100, true, true)).toEqual({ status: 'info', icon: 'insights' });
    expect(svc['burstWindowStatus'](650, 1000, 800, 100, false, true)).toEqual({ status: 'info', icon: 'insights' });
  });
});

describe('splitCommonCds', () => {
  it('routes known names to spell ids and unknown names to labels', () => {
    expect(svc['splitCommonCds'](['Shadow Blades', 'Mystery'], { 'Shadow Blades': SHADOW_BLADES }))
      .toEqual({ spellIds: [SHADOW_BLADES], labels: ['Mystery'] });
  });

  it('is empty for no cds', () => {
    expect(svc['splitCommonCds']([], {})).toEqual({ spellIds: [], labels: [] });
  });
});

describe('burstMapAnchor', () => {
  it('carries the window seek time', () => {
    const window = { time_s: 12, window_length_s: 18, common_cds: ['Shadow Blades', 'Mystery'] } as BurstWindow;
    expect(svc['burstMapAnchor'](window)).toEqual({ timeS: 12, windowLengthS: 18 });
  });
});

describe('burstClipAnchor', () => {
  it('carries the window span and a stable indexed key', () => {
    const window = { time_s: 12, window_length_s: 18 } as BurstWindow;
    expect(svc['burstClipAnchor'](window, 2)).toEqual({ timeS: 12, windowLengthS: 18, key: 'burst-2' });
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
    const view = svc['buildBurstView']([window], player, 300, { 'Shadow Blades': SHADOW_BLADES }, abilities);
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
    const view = svc['buildBurstView']([passiveWindow], [], 300, {}, abilities, true);
    expect(first(first(view.windows).detailRows).passive).toBe(true);
    // The default (non-passive) bench ability stays passive=false.
    const benchWindow = first(svc['buildBurstView']([window], [], 300, {}, abilities, true).windows);
    expect(first(benchWindow.detailRows).passive).toBe(false);
  });

  it('bench-only marks windows neutral info (no player overlay) instead of muted', () => {
    const burstWindow = first(svc['buildBurstView']([window], [], Number.POSITIVE_INFINITY, {}, abilities, true).windows);
    expect(burstWindow.status).toBe('info');
    expect(burstWindow.statusIcon).toBe('insights');
    expect(burstWindow.overview.playerPct).toBeNull();
  });
});

describe('findPlayerBurstWindows', () => {
  const window: BurstWindow = {
    time_s: 10, window_length_s: 20, dmg_avg: 0, dmg_min: 0, dmg_max: 0, dmg_stddev: 0, common_cds: [], ability_breakdown: [],
  };
  const HIT_S = 12, CAST_S = 11, HIT_DAMAGE = 400, CAST_COUNT = 1;

  it('bridges the damage id to the cast id through the report ability names', () => {
    const out = svc['findPlayerBurstWindows'](
      [window],
      timed([damage(SHADOW_BLADES_DAMAGE, HIT_S, HIT_DAMAGE)], 0),
      timed([cast(SHADOW_BLADES, CAST_S)], 0),
      // The two ids share one name, which is the only bridge between a cast and the damage it deals.
      new Map([[SHADOW_BLADES_DAMAGE, 'Shadow Blades'], [SHADOW_BLADES, 'Shadow Blades']]),
    );
    const breakdown = first(out).ability_breakdown;
    assert.exists(breakdown);
    expect(first(breakdown)).toMatchObject({ spell_id: SHADOW_BLADES_DAMAGE, casts: CAST_COUNT });
  });

  it('stands an unnamed ability up under its own id, so its casts still count', () => {
    const out = svc['findPlayerBurstWindows'](
      [window],
      timed([damage(SHADOW_BLADES, HIT_S, HIT_DAMAGE)], 0),
      timed([cast(SHADOW_BLADES, CAST_S)], 0),
      new Map(),
    );
    const breakdown = first(out).ability_breakdown;
    assert.exists(breakdown);
    expect(first(breakdown)).toMatchObject({ spell_id: SHADOW_BLADES, casts: CAST_COUNT });
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

describe('BurstFeatureService', () => {
  it('propagates the data-source error when the bench read fails', async () => {
    const result = await withBench(Results.missing('Not yet ingested.')).loadBenchView('SubtletyRogue', 1);
    expect(result).toEqual(Results.missing('Not yet ingested.'));
  });

  it('returns an ok bench view when the bench file exists', async () => {
    const result = await withBench(Results.ok(benchFixture)).loadBenchView('SubtletyRogue', 1);
    expect(result.ok).toBe(true);
  });

  it('bench-only: shows the top windows with no player overlay (neutral info status)', async () => {
    const result = await withBench(Results.ok(benchFixture)).loadBenchView('SubtletyRogue', 1);
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
    const result = await withBench(Results.ok(benchFixture)).loadPlayerView('SubtletyRogue', 1, 'rep', 1, 10);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.windows).toHaveLength(1);
    const burstWindow = first(result.value.windows);
    expect(burstWindow.overview.playerPct).toBe(950);
    expect(first(burstWindow.detailRows).label).toBe('Eviscerate');
    expect(result.value.anchors[0]).toEqual({ timeS: 10, windowLengthS: 20 });
  });

  it('wires the shared pull context with the bench-only view and the burst repro id', async () => {
    const MISSING_FIGHT_ID = 999;
    const FAILING_CODE = 'boom';
    // TestBed configures once per test, so one service with one refused report code covers both branches.
    const service = withBench(Results.ok(benchFixture), {
      ...wclFake,
      getReport: async (code: string) => { if (code === FAILING_CODE) throw new Error('WCL down'); return wclFake.getReport(); },
    });

    const onMissingFight = await service.loadPlayerView('SubtletyRogue', 1, 'rep', MISSING_FIGHT_ID, 10);
    expect(onMissingFight).toEqual(await service.loadBenchView('SubtletyRogue', 1));

    const onFailure = await service.loadPlayerView('SubtletyRogue', 1, FAILING_CODE, 1, 10);
    expect(onFailure.ok).toBe(false);
    if (!onFailure.ok) expect(onFailure.error).toMatchObject({ kind: 'permanent', id: 'burst.player-view' });
  });
});
