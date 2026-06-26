import { describe, it, expect } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { WclApiService } from '../../../core/services/wcl-api';
import { AnalysisFinding } from '../../../core/models/analysis.models';
import { PerCdBenchmark } from '../../../core/models/encounter.models';
import { WclEvent } from '../../../core/models/wcl.models';
import { ROTATION_DATA_SOURCE, RotationBench, RotationDataSource } from './rotation-data-source';
import {
  RotationFeatureService,
  isOutlierAbove, isCriticallyBelow, benchExpectedUses, closestToZero, castEfficiencyPct,
  fmtClock, sortBySeverity,
  evaluateCastWithoutPrior, evaluateHoldForAnchor, evaluateRules, buildCastTimes,
  analyzeRotationFindings, bucketRotationFindings, buildComparisonTable, buildCdPlan,
} from './rotation.service';

function cast(spellId: number, atS: number): WclEvent {
  return { type: 'cast', timestamp: atS * 1000, abilityGameID: spellId };
}
function buff(spellId: number, atS: number): WclEvent {
  return { type: 'applybuff', timestamp: atS * 1000, abilityGameID: spellId };
}

function cdBench(over: Partial<PerCdBenchmark> = {}): PerCdBenchmark {
  return {
    avg_first_cast_s: 5, stddev_first_cast_s: 2,
    avg_gap_s: 90, stddev_gap_s: 5,
    avg_bl_offset_s: 0, stddev_bl_offset_s: 2,
    avg_uses: 2, avg_uses_per_min: 1,
    uses_per_min: { avg: 1, stddev: 0.1, min: 0.9, max: 1.1 },
    bl_pct: 100, majority_hold: false, hold_targets: {}, sample_count: 5,
    ...over,
  };
}

function bench(over: Partial<RotationBench> = {}): RotationBench {
  return {
    spec: 'SubtletyRogue', encounter_id: 1, encounter_name: 'Boss', sample_count: 5,
    avg_duration_s: 120, downtime_threshold_ms: 1500, top_avg_efficiency: 90, top_efficiency_stddev: 3,
    per_cd_benchmarks: { 'Shadow Blades': cdBench() },
    major_cooldowns: [{ name: 'Shadow Blades', spell_id: 121471, cooldown: 90, align_with_bloodlust: true }],
    rules: [],
    cd_spell_ids: { 'Shadow Blades': 121471 },
    ability_icons: { 121471: { icon: 'sb', name: 'Shadow Blades' } },
    ...over,
  };
}

/* ----------------------------- statistical predicates ----------------------------- */

describe('statistical predicates', () => {
  it.each([
    { value: 11, mean: 5, stddev: 2, out: true },
    { value: 9, mean: 5, stddev: 2, out: false },
    { value: 8, mean: 5, stddev: 2, out: false },
  ])('isOutlierAbove($value)', ({ value, mean, stddev, out }) => {
    expect(isOutlierAbove(value, mean, stddev)).toBe(out);
  });

  it('isCriticallyBelow is true more than one stddev under', () => {
    expect(isCriticallyBelow(80, 90, 5)).toBe(true);
    expect(isCriticallyBelow(86, 90, 5)).toBe(false);
  });

  it('benchExpectedUses scales uses/min to the fight length', () => {
    expect(benchExpectedUses(120, { avg: 1, stddev: 0.1, min: 0, max: 0 })).toEqual({ expected: 2, floor: 2 });
  });

  it('closestToZero picks the smallest absolute offset', () => {
    expect(closestToZero([-3, 1, 5])).toBe(1);
  });

  it('castEfficiencyPct clamps to >= 0', () => {
    expect(castEfficiencyPct(0, 100)).toBe(100);
    expect(castEfficiencyPct(200, 100)).toBe(0);
  });

  it('fmtClock zero-pads minutes and seconds', () => {
    expect(fmtClock(65)).toBe('01:05');
  });

  it('sortBySeverity orders critical first, success last', () => {
    const findings: AnalysisFinding[] = [
      { severity: 'success', category: 'x', message: '' },
      { severity: 'critical', category: 'y', message: '' },
      { severity: 'warning', category: 'z', message: '' },
    ];
    sortBySeverity(findings);
    expect(findings.map(f => f.severity)).toEqual(['critical', 'warning', 'success']);
  });
});

/* ----------------------------- rule engine ----------------------------- */

describe('rule engine', () => {
  it('flags a cast without its required companion in window', () => {
    const castTimes = buildCastTimes([cast(100, 10), cast(200, 30)], 0);
    const finding = evaluateCastWithoutPrior(
      { kind: 'cast_without_prior', spell_id: 100, spell_name: 'A', required_spell_id: 200, required_spell_name: 'B', window_s: 5 },
      castTimes, 'warning', 'do x',
    );
    expect(finding).not.toBeNull();
    expect(finding!.measured).toEqual({ value: '1 / 1', unit: 'cast(s)' });
    expect(finding!.details?.remedy).toBe('do x');
  });

  it('passes when companion is within window', () => {
    const castTimes = buildCastTimes([cast(100, 10), cast(200, 12)], 0);
    expect(evaluateCastWithoutPrior(
      { kind: 'cast_without_prior', spell_id: 100, spell_name: 'A', required_spell_id: 200, required_spell_name: 'B', window_s: 5 },
      castTimes, 'warning',
    )).toBeNull();
  });

  it('flags a cooldown spent in the hold window before an anchor', () => {
    // anchor at 10 and 120; second anchor (120) is the one evaluated; cast at 110 is within 15s
    const castTimes = buildCastTimes([cast(1, 10), cast(1, 120), cast(2, 110)], 0);
    const finding = evaluateHoldForAnchor(
      { kind: 'hold_cooldown_for_anchor', spell_ids: [2], spell_names: ['Dance'], anchor_spell_id: 1, anchor_spell_name: 'Blades', hold_window_s: 15 },
      castTimes, 'critical',
    );
    expect(finding).not.toBeNull();
    expect(finding!.measured).toEqual({ value: '1', unit: 'charge(s)' });
  });

  it('evaluateRules skips rules without a condition', () => {
    const findings = evaluateRules([{ description: 'r', condition: null }], [cast(1, 1)], 0);
    expect(findings).toEqual([]);
  });
});

/* ----------------------------- offensive analysis ----------------------------- */

describe('analyzeRotationFindings', () => {
  it('emits a lost-cooldown critical when never used and expected', () => {
    const findings = analyzeRotationFindings(0, 120_000, [], [], bench().major_cooldowns, [], bench());
    const lost = findings.find(f => f.category === 'lost_cooldown');
    expect(lost?.severity).toBe('critical');
  });

  it('emits a success when used on cd and BL-aligned', () => {
    const casts = [cast(121471, 6)];
    const buffs = [buff(2825, 6)];
    const single = bench({ per_cd_benchmarks: { 'Shadow Blades': cdBench({ uses_per_min: { avg: 0.5, stddev: 0.1, min: 0.4, max: 0.6 } }) } });
    const findings = analyzeRotationFindings(0, 120_000, casts, buffs, single.major_cooldowns, [], single);
    const success = findings.find(f => f.category === 'cooldown_usage' && f.severity === 'success');
    expect(success).toBeDefined();
    expect(success!.message).toContain('BL-aligned');
  });

  it('flags a late opener', () => {
    const casts = [cast(121471, 40)];
    const buffs = [buff(2825, 38)];
    const findings = analyzeRotationFindings(0, 120_000, casts, buffs, bench().major_cooldowns, [], bench());
    expect(findings.some(f => f.category === 'cooldown_delay')).toBe(true);
  });
});

describe('bucketRotationFindings', () => {
  it('splits rule rows, cd issue rows and on-plan chips', () => {
    const findings: AnalysisFinding[] = [
      { severity: 'critical', category: 'rule_violation', label: 'A without B', message: '', measured: { value: '1 / 1' }, details: { remedy: 'fix' } },
      { severity: 'warning', category: 'cooldown_delay', cd_name: 'Shadow Blades', message: '', measured: { value: '+3s' }, timestamp_ms: 4000 },
      { severity: 'success', category: 'cooldown_usage', cd_name: 'Vanish', message: '' },
    ];
    const out = bucketRotationFindings(findings, { 'Shadow Blades': 121471, 'Vanish': 1856 });
    expect(out.ruleRows).toHaveLength(1);
    expect(out.ruleRows[0].what).toBe('A without B');
    expect(out.offensiveRows).toHaveLength(1);
    expect(out.offensiveRows[0]).toMatchObject({ name: 'Shadow Blades', spellId: 121471, chip: 'held' });
    expect(out.onPlan).toEqual([{ name: 'Vanish', spellId: 1856 }]);
  });

  it('does not put a cooldown with issues on plan even if it also has a success', () => {
    const findings: AnalysisFinding[] = [
      { severity: 'critical', category: 'lost_cooldown', cd_name: 'Shadow Blades', message: '', measured: { value: '0 / 2' } },
      { severity: 'success', category: 'cooldown_usage', cd_name: 'Shadow Blades', message: '' },
    ];
    const out = bucketRotationFindings(findings, { 'Shadow Blades': 121471 });
    expect(out.onPlan).toEqual([]);
    expect(out.offensiveRows).toHaveLength(1);
  });
});

describe('buildComparisonTable', () => {
  it('produces player uses/min and first cast next to the top parse', () => {
    const casts = [cast(121471, 5), cast(121471, 95)];
    const rows = buildComparisonTable(0, 120_000, casts, bench().major_cooldowns, bench());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      cd_name: 'Shadow Blades', spell_id: 121471, player_uses: 2,
      player_first_cast_s: 5, top_avg_first_cast_s: 5, top_avg_uses_per_min: 1,
    });
    expect(rows[0].player_uses_per_min).toBeCloseTo(1, 1);
  });
});

describe('buildCdPlan', () => {
  it('orders by opener priority and surfaces holds for majority-hold cds', () => {
    const cooldowns = [
      { name: 'Vanish', spell_id: 1856, cooldown: 120, opener_priority: 2, usage_rule: 'late' },
      { name: 'Shadow Blades', spell_id: 121471, cooldown: 90, opener_priority: 1, align_with_bloodlust: true, usage_rule: 'open' },
    ];
    const benchmarks = {
      'Shadow Blades': cdBench({ majority_hold: true, hold_targets: { '2': { target_s: 100, stddev_s: 5, count: 4, total_samples: 5 } } }),
      'Vanish': cdBench({ avg_first_cast_s: 20 }),
    };
    const plan = buildCdPlan(cooldowns, benchmarks);
    expect(plan.map(p => p.name)).toEqual(['Shadow Blades', 'Vanish']);
    expect(plan[0].holds).toEqual([{ castIndex: 2, targetS: 100 }]);
    expect(plan[0].bloodlust).toBe(true);
    expect(plan[0].bloodlustPct).toBe(100);
  });
});

/* ----------------------------- feature service ----------------------------- */

function withSource(value: RotationBench | null, wcl?: unknown): RotationFeatureService {
  const source: RotationDataSource = { getRotationBench: () => Promise.resolve(value) };
  TestBed.configureTestingModule({
    providers: [
      { provide: ROTATION_DATA_SOURCE, useValue: source },
      { provide: WclApiService, useValue: (wcl ?? {}) as WclApiService },
    ],
  });
  return TestBed.inject(RotationFeatureService);
}

describe('RotationFeatureService', () => {
  it('returns an empty player view when bench is absent', async () => {
    const service = withSource(null);
    const view = await service.loadPlayerView('SubtletyRogue', 1, 'rX', 1, 10);
    expect(view).toEqual({ ruleRows: [], offensiveRows: [], onPlan: [], comparison: [], abilityIcons: {} });
  });

  it('computes player findings + comparison from the player log', async () => {
    const wcl = {
      getReport: async () => ({
        title: 't', fights: [{ id: 1, name: 'Boss', startTime: 0, endTime: 120_000 }],
        masterData: { actors: [], abilities: [{ gameID: 121471, name: 'Shadow Blades', icon: 'sb' }] },
      }),
      getAllEvents: async (_c: string, _f: number, dataType: string) =>
        dataType === 'Casts' ? [cast(121471, 6)] : [buff(2825, 6)],
    };
    const single = bench({ per_cd_benchmarks: { 'Shadow Blades': cdBench({ uses_per_min: { avg: 0.5, stddev: 0.1, min: 0.4, max: 0.6 } }) } });
    const service = withSource(single, wcl);
    const view = await service.loadPlayerView('SubtletyRogue', 1, 'rX', 1, 10);
    expect(view.comparison).toHaveLength(1);
    expect(view.comparison[0].player_uses).toBe(1);
    expect(view.onPlan).toEqual([{ name: 'Shadow Blades', spellId: 121471 }]);
    expect(view.abilityIcons[121471]).toEqual({ icon: 'sb', name: 'Shadow Blades' });
  });

  it('returns bench-only plan rows for the pre-fight view', async () => {
    const service = withSource(bench({
      per_cd_benchmarks: { 'Shadow Blades': cdBench() },
    }));
    const view = await service.loadPlanView('SubtletyRogue', 1);
    expect(view.rows).toHaveLength(1);
    expect(view.rows[0].name).toBe('Shadow Blades');
    expect(view.abilityIcons[121471]).toEqual({ icon: 'sb', name: 'Shadow Blades' });
  });
});
