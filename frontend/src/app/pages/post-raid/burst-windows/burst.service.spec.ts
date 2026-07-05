import { describe, it, expect } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { BurstWindow, PlayerBurstWindow } from '../../../core/models/analysis.models';
import { WclApiService } from '../../../core/services/wcl-api';
import { BURST_DATA_SOURCE, BurstBench } from './burst-data-source';
import { DataSource } from '../../../core/data-source/data-source';
import {
  BurstFeatureService,
  burstWindowStatus, splitCommonCds, burstMapAnchor, burstClipAnchor, buildBurstView, findPlayerBurstWindows,
} from './burst.service';
import { SHADOW_BLADES, SHADOW_BLADES_DAMAGE } from '../../../../testing/spell-ids';
import { cast, damage } from '../../../../testing/builders/events';

/* ----------------------------- pure functions ----------------------------- */

describe('burstWindowStatus', () => {
  // topAvg 1000, topMin 800, stddev 100 -> bad below 700, warn below 900.
  it.each([
    { name: 'not reached -> muted', player: 950 as number | null, notReached: true, status: 'muted', icon: 'schedule' },
    { name: 'missing player data -> muted', player: null, notReached: false, status: 'muted', icon: 'help_outline' },
    { name: 'far below min -> bad', player: 650, notReached: false, status: 'bad', icon: 'error' },
    { name: 'below avg band -> warn', player: 850, notReached: false, status: 'warn', icon: 'warning_amber' },
    { name: 'within range -> good', player: 1000, notReached: false, status: 'good', icon: 'check_circle' },
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

describe('buildBurstView', () => {
  const window: BurstWindow = {
    time_s: 10, window_length_s: 20, dmg_avg: 1000, dmg_min: 800, dmg_max: 1200, dmg_stddev: 100,
    common_cds: ['Shadow Blades'],
    ability_breakdown: [
      { spell_id: SHADOW_BLADES_DAMAGE, avg_damage: 600, min_damage: 400, max_damage: 800, count: 5, avg_casts: 2 },
    ],
  };
  const abilities = { [SHADOW_BLADES]: { icon: 'sb', name: 'Shadow Blades' }, [SHADOW_BLADES_DAMAGE]: { icon: 'evis', name: 'Eviscerate' } };

  it('pairs each window with the player damage at the same index', () => {
    const player: PlayerBurstWindow[] = [
      { time_s: 10, window_damage: 950, ability_breakdown: [{ spell_id: SHADOW_BLADES_DAMAGE, damage: 550, casts: 2 }] },
    ];
    const view = buildBurstView([window], player, 300, { 'Shadow Blades': SHADOW_BLADES }, abilities);
    expect(view.windows).toHaveLength(1);
    expect(view.windows[0].overview.playerPct).toBe(950);
    expect(view.windows[0].spells).toEqual([{ id: SHADOW_BLADES, icon: 'sb', name: 'Shadow Blades' }]);
    expect(view.windows[0].detailRows[0]).toMatchObject({ spellId: SHADOW_BLADES_DAMAGE, label: 'Eviscerate', icon: 'evis', playerPct: 550, topAvg: 600 });
    expect(view.anchors[0]).toEqual({ timeS: 10, windowLengthS: 20 });
    expect(view.clipAnchors[0]).toEqual({ timeS: 10, windowLengthS: 20, key: 'burst-0' });
  });

  it('flags a detail row passive when the bench ability is passive', () => {
    const passiveWindow: BurstWindow = {
      ...window,
      ability_breakdown: [
        { spell_id: SHADOW_BLADES_DAMAGE, avg_damage: 600, min_damage: 400, max_damage: 800, count: 5, avg_casts: 0, is_passive: true },
      ],
    };
    const view = buildBurstView([passiveWindow], [], 300, {}, abilities, true);
    expect(view.windows[0].detailRows[0].passive).toBe(true);
    // The default (non-passive) bench ability stays passive=false.
    expect(buildBurstView([window], [], 300, {}, abilities, true).windows[0].detailRows[0].passive).toBe(false);
  });

  it('mutes and drops player data for a window the fight never reached', () => {
    const view = buildBurstView([window], [], 5, {}, abilities);
    expect(view.windows[0].status).toBe('muted');
    expect(view.windows[0].overview.playerPct).toBeNull();
  });

  it('bench-only marks windows neutral info (no player overlay) instead of muted', () => {
    const view = buildBurstView([window], [], Number.POSITIVE_INFINITY, {}, abilities, true);
    expect(view.windows[0].status).toBe('info');
    expect(view.windows[0].statusIcon).toBe('insights');
    expect(view.windows[0].overview.playerPct).toBeNull();
  });
});

/* ----------------------------- feature service ---------------------------- */

describe('findPlayerBurstWindows', () => {
  const window: BurstWindow = {
    time_s: 10, window_length_s: 20, dmg_avg: 0, dmg_min: 0, dmg_max: 0, dmg_stddev: 0, common_cds: [], ability_breakdown: [],
  };

  it('sums player damage inside the window and counts casts by ability name', () => {
    const out = findPlayerBurstWindows(
      [window],
      [damage(SHADOW_BLADES_DAMAGE, 12, 600), damage(SHADOW_BLADES_DAMAGE, 15, 400), damage(1, 999, 5000)],
      [cast(SHADOW_BLADES, 11), cast(SHADOW_BLADES, 13)],
      0,
      new Map([[SHADOW_BLADES_DAMAGE, 'Eviscerate'], [SHADOW_BLADES, 'Shadow Blades']]),
    );
    expect(out[0].window_damage).toBe(1000);
    expect(out[0].ability_breakdown![0]).toMatchObject({ spell_id: SHADOW_BLADES_DAMAGE, damage: 1000 });
  });

  it('excludes an event at exactly the window end (half-open)', () => {
    const out = findPlayerBurstWindows([window], [damage(SHADOW_BLADES_DAMAGE, 30, 800)], [], 0, new Map());
    expect(out[0].window_damage).toBe(0);
  });
});

const wclFake = {
  getReport: async () => ({
    title: 't',
    fights: [{ id: 1, name: 'Boss', startTime: 0, endTime: 300_000, kill: true, encounterID: 1, friendlyPlayers: [] }],
    masterData: { actors: [], abilities: [{ gameID: SHADOW_BLADES_DAMAGE, name: 'Eviscerate', icon: 'inv' }] },
  }),
  getAllEvents: async (_code: string, _fightId: number, dataType: string) =>
    dataType === 'Casts' ? [cast(SHADOW_BLADES, 11)] : [damage(SHADOW_BLADES_DAMAGE, 12, 950)],
};

function withBench(bench: BurstBench | null): BurstFeatureService {
  const source: DataSource<BurstBench> = { getBench: () => Promise.resolve(bench) };
  TestBed.configureTestingModule({
    providers: [
      { provide: BURST_DATA_SOURCE, useValue: source },
      { provide: WclApiService, useValue: wclFake as unknown as WclApiService },
    ],
  });
  return TestBed.inject(BurstFeatureService);
}

const benchFixture: BurstBench = {
  spec: 'SubtletyRogue', encounter_id: 1, encounter_name: 'Test', sample_count: 5,
  cd_spell_ids: { 'Shadow Blades': SHADOW_BLADES },
  ability_icons: { [SHADOW_BLADES]: { icon: 'sb', name: 'Shadow Blades' }, [SHADOW_BLADES_DAMAGE]: { icon: 'evis', name: 'Eviscerate' } },
  windows: [{
    time_s: 10, window_length_s: 20, dmg_avg: 1000, dmg_min: 800, dmg_max: 1200, dmg_stddev: 100,
    common_cds: ['Shadow Blades'],
    ability_breakdown: [{ spell_id: SHADOW_BLADES_DAMAGE, avg_damage: 600, min_damage: 400, max_damage: 800, count: 5, avg_casts: 2 }],
  }],
};

describe('BurstFeatureService', () => {
  it('returns an unavailable, empty view when the bench file is absent', async () => {
    const view = await withBench(null).loadBenchView('SubtletyRogue', 1);
    expect(view).toEqual({ available: false, windows: [], anchors: [], clipAnchors: [] });
  });

  it('marks the view available when the bench file exists', async () => {
    const view = await withBench(benchFixture).loadBenchView('SubtletyRogue', 1);
    expect(view.available).toBe(true);
  });

  it('bench-only: shows the top windows with no player overlay (neutral info status)', async () => {
    const view = await withBench(benchFixture).loadBenchView('SubtletyRogue', 1);
    expect(view.windows).toHaveLength(1);
    expect(view.windows[0].overview.playerPct).toBeNull();
    expect(view.windows[0].status).toBe('info');
    expect(view.windows[0].statusIcon).toBe('insights');
    expect(view.anchors[0]).toEqual({ timeS: 10, windowLengthS: 20 });
  });

  it('player view: fetches the log and compares the player damage against the bench', async () => {
    const view = await withBench(benchFixture).loadPlayerView('SubtletyRogue', 1, 'rep', 1, 10);
    expect(view.windows).toHaveLength(1);
    expect(view.windows[0].overview.playerPct).toBe(950);
    expect(view.windows[0].detailRows[0].label).toBe('Eviscerate');
    expect(view.anchors[0]).toEqual({ timeS: 10, windowLengthS: 20 });
  });
});
