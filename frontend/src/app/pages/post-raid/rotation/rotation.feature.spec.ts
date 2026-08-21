import { assert, describe, it, expect } from 'vitest';
import { WclTransportError } from '../../../core/services/wcl-transport';
import { Result, ok, missing, transient } from '../../../core/result';
import { RulebookRule, CastWithoutPriorCondition } from '../../../core/models/rulebook.models';
import {
  SHADOW_BLADES, SHADOW_DANCE, SECRET_TECHNIQUE, BLOODLUST, RUPTURE, BLACK_POWDER,
} from '../../../../testing/spell-ids';
import { cast, applyBuff, applyDebuff, removeDebuff } from '../../../../testing/builders/events';
import { WclEvent } from '../../../core/models/wcl.models';
import { ROTATION_DATA_SOURCE, RotationBench } from './rotation-data-source';
import { sliceService } from '../../../../testing/service-harness';
import { BenchedRule, RuleBand } from './rotation-rules';
import { RotationFeatureService } from './rotation.service';
import { bench, cdBench } from './rotation-harness';

// A zero tolerance keeps the fixture arithmetic exact.
const PAIR_WINDOW_S = 5;
function band(lo: number, hi = lo, tolerance = 0): RuleBand {
  return { lo, hi, tolerance };
}

// A rule whose band this encounter measured, so fixtures about something else are not gated on it.
function benched(rule: RulebookRule, ruleBand: RuleBand | null = band(PAIR_WINDOW_S)): BenchedRule {
  return { rule, band: ruleBand, sample_count: ruleBand == null ? 0 : 10 };
}

// A real Subtlety rule, so the feature-service fixtures exercise a shape the rulebooks actually carry.
const SECRET_TECH_NEEDS_DANCE: CastWithoutPriorCondition = {
  kind: 'cast_without_prior',
  spell_id: SECRET_TECHNIQUE, spell_name: 'Secret Technique',
  required_spell_id: SHADOW_DANCE, required_spell_name: 'Shadow Dance',
};

// Resolves a valid (empty) player log, so a test's outcome is driven by the bench Result rather than an incidental transport throw.
const WORKING_WCL = {
  getReport: async () => ({
    title: 't', fights: [{ id: 1, name: 'Boss', startTime: 0, endTime: 120_000 }],
    masterData: { actors: [], abilities: [] },
  }),
  getAllEvents: async () => [],
};

// Status a 5xx WCL outage raises; `toLoadError` maps it to a transient error.
const WCL_UNAVAILABLE_STATUS = 503;

function withSource(bench: Result<RotationBench>, wcl: unknown = WORKING_WCL): RotationFeatureService {
  return sliceService(ROTATION_DATA_SOURCE, RotationFeatureService, bench, wcl);
}

describe('RotationFeatureService', () => {
  it('surfaces a missing bench so the offensives waiting state shows', async () => {
    // A working WCL fake proves the missing comes from the bench read, not a player-log failure.
    const service = withSource(missing('Not yet ingested.'));
    const result = await service.loadPlayerView('SubtletyRogue', 1, 'rX', 1, 10);
    expect(result).toEqual(missing('Not yet ingested.'));
  });

  it('surfaces a WCL failure as a transient error instead of a silent empty view', async () => {
    const failingWcl = { getReport: async () => { throw new WclTransportError('WCL down', WCL_UNAVAILABLE_STATUS); } };
    const service = withSource(ok(bench()), failingWcl);
    const result = await service.loadPlayerView('SubtletyRogue', 1, 'rX', 1, 10);
    expect(result).toEqual(transient('WCL is unreachable right now.'));
  });

  it('evaluates the rotation rules baked into the bench', async () => {
    const wcl = {
      getReport: async () => ({ title: 't', fights: [{ id: 1, name: 'Boss', startTime: 0, endTime: 120_000 }], masterData: { actors: [], abilities: [] } }),
      getAllEvents: async (_c: string, _f: number, dataType: string) =>
        dataType === 'Casts' ? [cast(SHADOW_DANCE, 10), cast(SECRET_TECHNIQUE, 30)] : [],
    };
    const rule: RulebookRule = { severity: 'critical', condition: SECRET_TECH_NEEDS_DANCE };
    const service = withSource(ok(bench({ rules: [benched(rule)] })), wcl);
    const result = await service.loadPlayerView('SubtletyRogue', 1, 'rX', 1, 10);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // The sparse cast fixture also yields a separate cast-efficiency row, so assert on the rule row rather than the count.
      const ruleRows = result.value.ruleRows.filter(row => row.what === 'Secret Technique without Shadow Dance');
      expect(ruleRows).toHaveLength(1);
    }
  });

  it('computes player findings from the player log', async () => {
    const wcl = {
      getReport: async () => ({
        title: 't', fights: [{ id: 1, name: 'Boss', startTime: 0, endTime: 120_000 }],
        masterData: { actors: [], abilities: [{ gameID: SHADOW_BLADES, name: 'Shadow Blades', icon: 'sb' }] },
      }),
      getAllEvents: async (_c: string, _f: number, dataType: string) =>
        dataType === 'Casts' ? [cast(SHADOW_BLADES, 6)] : [applyBuff(BLOODLUST, 6)],
    };
    const single = bench({ per_cd_benchmarks: { 'Shadow Blades': cdBench({ uses_per_min: { avg: 0.5, stddev: 0.1 } }) } });
    const service = withSource(ok(single), wcl);
    const result = await service.loadPlayerView('SubtletyRogue', 1, 'rX', 1, 10);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.onPlan).toEqual([{ name: 'Shadow Blades', spellId: SHADOW_BLADES, icon: 'sb' }]);
  });

  it('returns bench-only plan rows for the pre-fight view', async () => {
    const service = withSource(ok(bench({
      per_cd_benchmarks: { 'Shadow Blades': cdBench() },
    })));
    const result = await service.loadPlanView('SubtletyRogue', 1);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.rows).toHaveLength(1);
      assert.exists(result.value.rows[0]);
      expect(result.value.rows[0].name).toBe('Shadow Blades');
      assert.exists(result.value.rows[0]);
      expect(result.value.rows[0].icon).toBe('sb');
    }
  });

  it('propagates a missing bench so the pre-fight plan waiting state shows', async () => {
    const service = withSource(missing('Not yet ingested.'));
    expect(await service.loadPlanView('SubtletyRogue', 1)).toEqual(missing('Not yet ingested.'));
  });
});

describe('RotationFeatureService fetch shape', () => {
  const REPORT = { title: 't', fights: [{ id: 1, name: 'Boss', startTime: 0, endTime: 120_000 }], masterData: { actors: [], abilities: [] } };
  const PLAYER_ID = 10;
  const dotUptime: RulebookRule = {
    severity: 'warning',
    condition: { kind: 'aura_uptime_below', aura_spell_id: RUPTURE, aura_spell_name: 'Rupture', on: 'target' },
  };
  const aoeSwitch: RulebookRule = {
    severity: 'warning',
    condition: { kind: 'cast_at_target_count', spell_id: BLACK_POWDER, spell_name: 'Black Powder', bound: 'min' },
  };

  function recording(events: WclEvent[] = []) {
    const calls: { dataType: string; sourceId?: number; includeResources: boolean; hostilityType?: string }[] = [];
    return {
      calls,
      api: {
        getReport: async () => REPORT,
        getAllEvents: async (
          _c: string, _f: number, dataType: string, _s: number, _e: number,
          sourceId?: number, includeResources = false, hostilityType?: string,
        ) => {
          calls.push({ dataType, sourceId, includeResources, hostilityType });
          return events;
        },
      },
    };
  }

  const UPTIME_BAR_PCT = 90;

  it('requests player casts with resources on, which resource_at_cast depends on', async () => {
    const { calls, api } = recording();
    await withSource(ok(bench()), api).loadPlayerView('SubtletyRogue', 1, 'rX', 1, PLAYER_ID);
    expect(calls).toContainEqual({ dataType: 'Casts', sourceId: PLAYER_ID, includeResources: true, hostilityType: undefined });
  });

  it('skips the enemy-aura and damage fetches when no rule reads them', async () => {
    const { calls, api } = recording();
    await withSource(ok(bench()), api).loadPlayerView('SubtletyRogue', 1, 'rX', 1, PLAYER_ID);
    expect(calls.some(call => call.dataType === 'Debuffs')).toBe(false);
    expect(calls.some(call => call.dataType === 'DamageDone')).toBe(false);
  });

  it('fetches enemy auras with Enemies hostility and no source, the only shape WCL answers', async () => {
    const { calls, api } = recording();
    await withSource(ok(bench({ rules: [benched(dotUptime)] })), api).loadPlayerView('SubtletyRogue', 1, 'rX', 1, PLAYER_ID);
    expect(calls).toContainEqual({ dataType: 'Debuffs', sourceId: undefined, includeResources: false, hostilityType: 'Enemies' });
  });

  it('keeps only the auras the player applied out of the raid-wide enemy stream', async () => {
    const OTHER_RAIDER = 99;
    // A third of the pull against a 90% bar, so leaving these in would produce a violation row rather than silence.
    const raidWide = [
      { ...applyDebuff(RUPTURE, 0), sourceID: OTHER_RAIDER },
      { ...removeDebuff(RUPTURE, 40), sourceID: OTHER_RAIDER },
    ];
    const { api } = recording(raidWide);
    const result = await withSource(ok(bench({ rules: [benched(dotUptime, band(UPTIME_BAR_PCT))] })), api)
      .loadPlayerView('SubtletyRogue', 1, 'rX', 1, PLAYER_ID);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.ruleRows.some(row => row.what?.includes('Rupture'))).toBe(false);
  });

  it('fetches the player damage only when a target-count rule needs it', async () => {
    const { calls, api } = recording();
    await withSource(ok(bench({ rules: [benched(aoeSwitch)] })), api).loadPlayerView('SubtletyRogue', 1, 'rX', 1, PLAYER_ID);
    expect(calls).toContainEqual({ dataType: 'DamageDone', sourceId: PLAYER_ID, includeResources: false, hostilityType: undefined });
  });
});
