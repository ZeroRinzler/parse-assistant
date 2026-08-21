import { assert, describe, it, expect } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { WclApiService } from '../../../core/services/wcl-api';
import { DEFENSIVE_DATA_SOURCE, DefensiveBench } from './defensive-data-source';
import { DataSource } from '../../../core/data-source/data-source';
import { DefensiveFeatureService } from './defensive.service';
import { applyBuff, removeBuff, damageTaken } from '../../../../testing/builders/events';
import { CLOAK_OF_SHADOWS } from '../../../../testing/spell-ids';
import { Result, ok, missing } from '../../../core/result';
import { CLOAK_META, defBench } from './defensive-harness';

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

  it('propagates a missing bench so the pre-fight plan waiting state shows', async () => {
    const service = serviceWith(missing('Not yet ingested.'));
    expect(await service.loadPlan('SubtletyRogue', 1)).toEqual(missing('Not yet ingested.'));
  });
});
