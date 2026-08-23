import { assert, describe, it, expect } from 'vitest';
import { DEFENSIVE_DATA_SOURCE, DefensiveBench } from '../data-access/defensive-data-source';
import { sliceService } from '../../../../../testing/service-harness';
import { DefensiveFeatureService } from './defensive-feature-service';
import { applyBuff, removeBuff, damageTaken } from '../../../../../testing/builders/events';
import { CLOAK_OF_SHADOWS } from '../../../../../testing/spell-ids';
import { wclReport } from '../../../../../testing/builders/wcl-fixtures';
import { Result, Results } from '../../../../core/http/result';
import { BOSS_HIT_SPELL_ID, WINDOW_REF_GAME_ID, fullBench } from './defensive-harness';

function serviceWith(bench: Result<DefensiveBench>, wcl: Record<string, unknown> = {}): DefensiveFeatureService {
  return sliceService(DEFENSIVE_DATA_SOURCE, DefensiveFeatureService, bench, wcl);
}

describe('DefensiveFeatureService.loadAnalysisView (post-raid)', () => {
  it('propagates a non-ok bench unchanged (missing drives the waiting state)', async () => {
    const service = serviceWith(Results.missing('Not yet ingested.'));
    const result = await service.loadAnalysisView('SubtletyRogue', 1, 'r1', 1, 10);
    expect(result).toEqual(Results.missing('Not yet ingested.'));
  });

  it('computes player findings + windows from the player log', async () => {
    const report = wclReport({ playerName: 'P', abilities: [{ gameID: BOSS_HIT_SPELL_ID, name: 'Boss Hit', icon: 'hit' }] });
    const wcl = {
      getReport: async () => report,
      getAllEvents: async (_c: string, _f: number, dataType: string) => {
        if (dataType === 'Buffs') return [applyBuff(CLOAK_OF_SHADOWS, 30), removeBuff(CLOAK_OF_SHADOWS, 35)];
        if (dataType === 'Casts') return [];
        return [damageTaken(BOSS_HIT_SPELL_ID, 32, 1150)]; // t=32 falls inside the 30-35 buff window
      },
    };
    const service = serviceWith(Results.ok(fullBench()), wcl);
    const result = await service.loadAnalysisView('SubtletyRogue', 1, 'r1', 1, 10);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.spellIdsByName).toEqual({ 'Cloak of Shadows': CLOAK_OF_SHADOWS });
    expect(result.value.iconByName).toEqual({ 'Cloak of Shadows': 'cloak' });
    expect(result.value.windows).toHaveLength(1);
    assert.exists(result.value.windows[0]);
    expect(result.value.windows[0].overview.playerPct).toBe(1150);
    expect(result.value.anchors[0]).toMatchObject({ refGameId: WINDOW_REF_GAME_ID });
    // 1 use vs avg ~2, but only one buff window -> first cast at 30 (late) gives a warning finding.
    expect(result.value.findings.length).toBeGreaterThan(0);
  });

  it('does not throw and yields an empty icon when a cd spell id is missing from the ability map', async () => {
    const report = wclReport({ playerName: 'P' });
    const wcl = { getReport: async () => report, getAllEvents: async () => [] };
    // ability_icons intentionally omits CLOAK_OF_SHADOWS even though cd_spell_ids still references it.
    const bench = { ...fullBench(), ability_icons: {} };
    const service = serviceWith(Results.ok(bench), wcl);
    const result = await service.loadAnalysisView('SubtletyRogue', 1, 'r1', 1, 10);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.iconByName).toEqual({ 'Cloak of Shadows': '' });
  });

  it('wires the shared pull context with the empty defensive view and the defensive repro id', async () => {
    const UNLOGGED_FIGHT_ID = 99;
    const FAILING_CODE = 'boom';
    // TestBed configures once per test, so one service with one refused report code covers both branches.
    const service = serviceWith(Results.ok(fullBench()), {
      getReport: async (code: string) => {
        if (code === FAILING_CODE) throw new Error('WCL down');
        return wclReport({ fights: [], actors: [] });
      },
      getAllEvents: async () => [],
    });

    const onMissingFight = await service.loadAnalysisView('SubtletyRogue', 1, 'r1', UNLOGGED_FIGHT_ID, 10);
    expect(onMissingFight).toEqual(Results.ok({
      findings: [], spellIdsByName: { 'Cloak of Shadows': CLOAK_OF_SHADOWS }, iconByName: {},
      windows: [], anchors: [], clipAnchors: [],
    }));

    const onFailure = await service.loadAnalysisView('SubtletyRogue', 1, FAILING_CODE, 1, 10);
    expect(onFailure.ok).toBe(false);
    if (!onFailure.ok) expect(onFailure.error).toMatchObject({ kind: 'permanent', id: 'defensive.player-view' });
  });
});

describe('DefensiveFeatureService.loadPlan (pre-fight)', () => {
  it('returns the bench-only plan rows', async () => {
    const service = serviceWith(Results.ok(fullBench()));
    const result = await service.loadPlan('SubtletyRogue', 1);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.rows).toHaveLength(1);
      expect(result.value.rows[0]).toMatchObject({ name: 'Cloak of Shadows', spellId: CLOAK_OF_SHADOWS, typicalUses: 2, firstCastS: 10, windowsS: [30] });
    }
  });

  it('propagates a missing bench so the pre-fight plan waiting state shows', async () => {
    const service = serviceWith(Results.missing('Not yet ingested.'));
    expect(await service.loadPlan('SubtletyRogue', 1)).toEqual(Results.missing('Not yet ingested.'));
  });
});
