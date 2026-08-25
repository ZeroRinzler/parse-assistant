import { describe, it, expect } from 'vitest';
import { WclCombatantInfo } from '../../../../core/wcl/wcl.models';
import { GEAR_DATA_SOURCE, GearBench } from '../../../../domain/gear/gear-bench';
import { sliceService } from '../../../../../testing/service-harness';
import { Result, Results } from '../../../../core/http/result';
import { TalentsFeatureService } from './talents-feature-service';
import { TestBed } from '@angular/core/testing';
import { WCL_TRANSPORT } from '../../../../core/wcl/wcl-transport';
import { DATA_FILE_TRANSPORT } from '../../../../core/data-files/data-file-transport';

TestBed.configureTestingModule({ providers: [
  { provide: WCL_TRANSPORT, useValue: {} },
  { provide: DATA_FILE_TRANSPORT, useValue: { readJson: () => new Promise(() => undefined) } },
  { provide: GEAR_DATA_SOURCE, useValue: {} },
] });
const svc = TestBed.inject(TalentsFeatureService);
TestBed.resetTestingModule();

const STANDARD_KEY = 'v3:11.1,22.1';

function benchWith(overrides: Partial<GearBench> = {}): GearBench {
  return {
    spec: 'SubtletyRogue', encounter_id: 1, encounter_name: 'Boss', sample_count: 10,
    talent_builds: [{ key: STANDARD_KEY, pct: 80, report_code: 'abc', fight_id: 2, player_name: 'Top', source_id: 5, diff: [] }],
    trinkets: {}, enchants: {},
    ...overrides,
  };
}

// Reconstructs a raw CombatantInfo event carrying only a talent tree; gear must be non-empty for the fetch to count as "present".
function toRawEvent(talentKey: string): WclCombatantInfo {
  const body = talentKey.replace(/^v3:/, '');
  const talentTree = body ? body.split(',').map(pick => {
    const [id, rank] = pick.split('.').map(Number);
    return { id, rank };
  }) : [];
  return { sourceID: 10, gear: [{ id: 1, name: 'x' }], talentTree };
}

describe('buildView', () => {
  const stats = { talent_builds: benchWith().talent_builds, trinkets: {}, enchants: {} };

  it('comparison mode: player on the standard build', () => {
    const view = svc['buildView'](STANDARD_KEY, stats);
    expect(view.comparison).toBe(true);
    expect(view.talentStatus.status).toBe('ok');
    expect(view.talentBuilds[0]).toMatchObject({ pct: 80, label: 'Most common build' });
  });

  it('comparison mode: an off-meta build warns', () => {
    const view = svc['buildView']('v3:99.1', stats);
    expect(view.talentStatus.status).toBe('warn');
  });
});

describe('buildBenchView', () => {
  it('comparison off, talent builds populated from the bench alone', () => {
    const stats = { talent_builds: benchWith().talent_builds, trinkets: {}, enchants: {} };
    const view = svc['buildBenchView'](stats);
    expect(view.comparison).toBe(false);
    expect(view.talentBuilds[0]).toMatchObject({ pct: 80, label: 'Most common build' });
  });
});

describe('emptyView', () => {
  it('is a bench-off placeholder with no builds', () => {
    expect(svc.emptyView()).toEqual({
      comparison: false,
      talentBuilds: [],
      talentStatus: { status: 'unknown', note: 'No talent data.' },
    });
  });
});

function configure(bench: Result<GearBench>, talentKey: string | null): TalentsFeatureService {
  const wclFake = {
    getCombatantInfo: async (): Promise<WclCombatantInfo[]> => (talentKey != null ? [toRawEvent(talentKey)] : []),
  };
  return sliceService(GEAR_DATA_SOURCE, TalentsFeatureService, bench, wclFake);
}

describe('TalentsFeatureService', () => {
  it('loadBenchView builds the bench-only view', async () => {
    const result = await configure(Results.ok(benchWith()), null).loadBenchView('SubtletyRogue', 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.comparison).toBe(false);
    expect(result.value.talentBuilds).toHaveLength(1);
  });

  it('loadBenchView propagates a missing bench unchanged', async () => {
    const result = await configure(Results.missing('Not yet ingested.'), null).loadBenchView('SubtletyRogue', 1);
    expect(result).toEqual(Results.missing('Not yet ingested.'));
  });

  it('loadComparisonView merges the player\'s talent key with the bench', async () => {
    const result = await configure(Results.ok(benchWith()), STANDARD_KEY).loadComparisonView('SubtletyRogue', 1, 'r1', 3, 10);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.comparison).toBe(true);
    expect(result.value.talentStatus.status).toBe('ok');
  });

  it('loadComparisonView surfaces a permanent error when the player has no combatant info', async () => {
    const result = await configure(Results.ok(benchWith()), null).loadComparisonView('SubtletyRogue', 1, 'r1', 3, 10);
    expect(result).toEqual(Results.permanent('No combatant info in this log.', 'talents.combatant-info'));
  });

  it('loadComparisonView propagates a missing bench before fetching the player talent key', async () => {
    const result = await configure(Results.missing('Not yet ingested.'), null).loadComparisonView('SubtletyRogue', 1, 'r1', 3, 10);
    expect(result).toEqual(Results.missing('Not yet ingested.'));
  });
});
