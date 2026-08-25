import { describe, it, expect } from 'vitest';
import { SecondaryStats, WclCombatantInfo } from '../../../../core/wcl/wcl.models';
import { GEAR_DATA_SOURCE, GearBench } from '../../../../domain/gear/gear-bench';
import { sliceService } from '../../../../../testing/service-harness';
import { Result, Results } from '../../../../core/http/result';
import { StatsFeatureService } from './stats-feature-service';
import { TestBed } from '@angular/core/testing';
import { WCL_TRANSPORT } from '../../../../core/wcl/wcl-transport';
import { DATA_FILE_TRANSPORT } from '../../../../core/data-files/data-file-transport';

TestBed.configureTestingModule({ providers: [
  { provide: WCL_TRANSPORT, useValue: {} },
  { provide: DATA_FILE_TRANSPORT, useValue: { readJson: () => new Promise(() => undefined) } },
  { provide: GEAR_DATA_SOURCE, useValue: {} },
] });
const svc = TestBed.inject(StatsFeatureService);
TestBed.resetTestingModule();

const BENCH_STATS: SecondaryStats = {
  primary: 2000, stamina: 30000, crit: 900, haste: 900, mastery: 700, versatility: 200, avoidance: 50, leech: 200, speed: 60,
};
const PLAYER_STATS: SecondaryStats = {
  primary: 2100, stamina: 31000, crit: 940, haste: 880, mastery: 710, versatility: 210, avoidance: 55, leech: 210, speed: 65,
};

function benchWith(overrides: Partial<GearBench> = {}): GearBench {
  return {
    spec: 'SubtletyRogue', encounter_id: 1, encounter_name: 'Boss', sample_count: 10,
    talent_builds: [], trinkets: {}, enchants: {},
    avg_stats: BENCH_STATS,
    avg_item_level: 320,
    ...overrides,
  };
}

// Reconstructs a raw CombatantInfo event carrying stats+gear; names don't matter here.
function toRawEvent(): WclCombatantInfo {
  return {
    sourceID: 10,
    gear: [{ id: 1, name: 'x', itemLevel: 330 }],
    agility: PLAYER_STATS.primary, stamina: PLAYER_STATS.stamina, critMelee: PLAYER_STATS.crit, hasteMelee: PLAYER_STATS.haste,
    mastery: PLAYER_STATS.mastery, versatilityDamageDone: PLAYER_STATS.versatility, avoidance: PLAYER_STATS.avoidance,
    leech: PLAYER_STATS.leech, speed: PLAYER_STATS.speed,
  };
}

describe('buildView', () => {
  it('is one row per stat, both raw values plus delta = player - bench, item level first', () => {
    const view = svc['buildView']({ stats: PLAYER_STATS, itemLevel: 330 }, benchWith());
    expect(view.comparison).toBe(true);
    expect(view.rows[0]).toEqual({ label: 'Item level', player: 330, bench: 320, delta: 10 });
    expect(view.rows.find(r => r.label === 'Crit')).toEqual({ label: 'Crit', player: 940, bench: 900, delta: 40 });
    expect(view.rows.find(r => r.label === 'Haste')).toEqual({ label: 'Haste', player: 880, bench: 900, delta: -20 });
  });

  it('is empty rows (not a crash) when the bench carries no stats', () => {
    const view = svc['buildView']({ stats: PLAYER_STATS, itemLevel: 330 }, benchWith({ avg_stats: undefined }));
    expect(view).toEqual({ comparison: true, rows: [], benchRows: [] });
  });
});

describe('buildBenchView', () => {
  it('is one raw-value row per stat, bench-only (no delta)', () => {
    const view = svc['buildBenchView'](benchWith());
    expect(view.comparison).toBe(false);
    expect(view.benchRows[0]).toEqual({ label: 'Item level', value: 320 });
    expect(view.benchRows.find(r => r.label === 'Mastery')).toEqual({ label: 'Mastery', value: 700 });
  });

  it('is empty benchRows when the bench carries no stats', () => {
    expect(svc['buildBenchView'](benchWith({ avg_item_level: undefined }))).toEqual({ comparison: false, rows: [], benchRows: [] });
  });
});

describe('emptyView', () => {
  it('is a bench-off placeholder with no rows', () => {
    expect(svc.emptyView()).toEqual({ comparison: false, rows: [], benchRows: [] });
  });
});

function configure(bench: Result<GearBench>, hasPlayer: boolean): StatsFeatureService {
  const wclFake = {
    getCombatantInfo: async (): Promise<WclCombatantInfo[]> => (hasPlayer ? [toRawEvent()] : []),
  };
  return sliceService(GEAR_DATA_SOURCE, StatsFeatureService, bench, wclFake);
}

describe('StatsFeatureService', () => {
  it('loadBenchView builds the bench-only view', async () => {
    const result = await configure(Results.ok(benchWith()), false).loadBenchView('SubtletyRogue', 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.comparison).toBe(false);
    expect(result.value.benchRows.length).toBeGreaterThan(0);
  });

  it('loadBenchView propagates a missing bench unchanged', async () => {
    const result = await configure(Results.missing('Not yet ingested.'), false).loadBenchView('SubtletyRogue', 1);
    expect(result).toEqual(Results.missing('Not yet ingested.'));
  });

  it('loadComparisonView merges the player\'s fetched stats with the bench', async () => {
    const result = await configure(Results.ok(benchWith()), true).loadComparisonView('SubtletyRogue', 1, 'r1', 3, 10);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.comparison).toBe(true);
    expect(result.value.rows.length).toBeGreaterThan(0);
  });

  it('loadComparisonView surfaces a permanent error when the player has no combatant info', async () => {
    const result = await configure(Results.ok(benchWith()), false).loadComparisonView('SubtletyRogue', 1, 'r1', 3, 10);
    expect(result).toEqual(Results.permanent('No combatant info in this log.', 'stats.combatant-info'));
  });

  it('loadComparisonView propagates a missing bench before fetching player stats', async () => {
    const result = await configure(Results.missing('Not yet ingested.'), false).loadComparisonView('SubtletyRogue', 1, 'r1', 3, 10);
    expect(result).toEqual(Results.missing('Not yet ingested.'));
  });
});
