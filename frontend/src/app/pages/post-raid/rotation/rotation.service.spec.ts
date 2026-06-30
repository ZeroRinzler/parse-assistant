import { describe, it, expect } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { WclApiService } from '../../../core/services/wcl-api';
import { AnalysisFinding } from '../../../core/models/analysis.models';
import { PerCdBenchmark } from '../../../core/models/encounter.models';
import { RulebookRule, CastWithoutPriorCondition, HoldCooldownForAnchorCondition } from '../../../core/models/rulebook.models';
import { WclEvent } from '../../../core/models/wcl.models';
import { SHADOW_BLADES, SHADOW_DANCE, SECRET_TECHNIQUE, VANISH, BLOODLUST } from '../../../../testing/spell-ids';
import {
  isOutlierAbove, isCriticallyBelow, benchExpectedUses, closestToZero, castEfficiencyPct,
  fmtClock, sortBySeverity,
} from '../../../shared/analysis/analysis-math';
import { ROTATION_DATA_SOURCE, RotationBench } from './rotation-data-source';
import { DataSource } from '../../../core/data-source/data-source';
import {
  RotationFeatureService,
  evaluateCastWithoutPrior, evaluateHoldForAnchor, evaluateRules, buildCastTimes,
  analyzeRotationFindings, RotationScanInput, bucketRotationFindings, buildCdPlan,
  ruleLabel, rulesFollowed,
  checkLostUses, checkFirstCastDelay, checkBloodlustAlignment, checkGaps,
  checkHoldSuggestions, checkCastEfficiency, analyzeOneCooldown,
  partitionRotationFindings, buildRuleRows, buildOffensiveRows, buildOnPlanChips,
} from './rotation.service';

function cast(spellId: number, atS: number): WclEvent {
  return { type: 'cast', timestamp: atS * 1000, abilityGameID: spellId };
}
function buff(spellId: number, atS: number): WclEvent {
  return { type: 'applybuff', timestamp: atS * 1000, abilityGameID: spellId };
}

// Build a RotationScanInput for a 0..120s fight - keeps the call sites terse.
function scan(over: Partial<RotationScanInput> & { bench: RotationBench }): RotationScanInput {
  return {
    fStart: 0, fEnd: 120_000, castEvents: [], buffEvents: [],
    cooldowns: over.bench.major_cooldowns, rules: [],
    ...over,
  };
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
    major_cooldowns: [{ name: 'Shadow Blades', spell_id: SHADOW_BLADES, cooldown: 90, align_with_bloodlust: true }],
    rules: [],
    cd_spell_ids: { 'Shadow Blades': SHADOW_BLADES },
    ability_icons: { [SHADOW_BLADES]: { icon: 'sb', name: 'Shadow Blades' } },
    ...over,
  };
}

// Two real Subtlety rules reused across the rule-engine and rules-followed specs.
const DANCE_NEEDS_SECRET_TECH: CastWithoutPriorCondition = {
  kind: 'cast_without_prior',
  spell_id: SHADOW_DANCE, spell_name: 'Shadow Dance',
  required_spell_id: SECRET_TECHNIQUE, required_spell_name: 'Secret Technique', window_s: 5,
};
const HOLD_DANCE_FOR_BLADES: HoldCooldownForAnchorCondition = {
  kind: 'hold_cooldown_for_anchor',
  spell_ids: [SHADOW_DANCE], spell_names: ['Shadow Dance'],
  anchor_spell_id: SHADOW_BLADES, anchor_spell_name: 'Shadow Blades', hold_window_s: 15,
};

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
    expect(benchExpectedUses(120, { avg: 1, stddev: 0.1 })).toEqual({ expected: 2, floor: 2 });
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
  it('flags Shadow Dance cast without Secret Technique in window', () => {
    const castTimes = buildCastTimes([cast(SHADOW_DANCE, 10), cast(SECRET_TECHNIQUE, 30)], 0);
    const finding = evaluateCastWithoutPrior(DANCE_NEEDS_SECRET_TECH, castTimes, 'warning', 'do x');
    expect(finding).not.toBeNull();
    expect(finding!.measured).toEqual({ value: '1 / 1', unit: 'cast(s)' });
    expect(finding!.details?.remedy).toBe('do x');
  });

  it('passes when Secret Technique lands within the window', () => {
    const castTimes = buildCastTimes([cast(SHADOW_DANCE, 10), cast(SECRET_TECHNIQUE, 12)], 0);
    expect(evaluateCastWithoutPrior(DANCE_NEEDS_SECRET_TECH, castTimes, 'warning')).toBeNull();
  });

  it('flags Shadow Dance spent in the hold window before Shadow Blades', () => {
    // Shadow Blades at 10 and 120; the second (120) is the one evaluated; Shadow Dance at 110 is within 15s.
    const castTimes = buildCastTimes([cast(SHADOW_BLADES, 10), cast(SHADOW_BLADES, 120), cast(SHADOW_DANCE, 110)], 0);
    const finding = evaluateHoldForAnchor(HOLD_DANCE_FOR_BLADES, castTimes, 'critical');
    expect(finding).not.toBeNull();
    expect(finding!.measured).toEqual({ value: '1', unit: 'charge(s)' });
  });

  it('evaluateRules skips rules without a condition', () => {
    const findings = evaluateRules([{ description: 'r', condition: null }], [cast(SHADOW_DANCE, 1)], 0);
    expect(findings).toEqual([]);
  });
});

/* ----------------------------- rules followed (on-plan) ----------------------------- */

describe('ruleLabel', () => {
  it('prefers the rule description when present', () => {
    expect(ruleLabel(DANCE_NEEDS_SECRET_TECH, 'Pair Shadow Dance with Secret Technique'))
      .toBe('Pair Shadow Dance with Secret Technique');
  });

  it('describes a paired-cast rule as "<spell> with <required>"', () => {
    expect(ruleLabel(DANCE_NEEDS_SECRET_TECH)).toBe('Shadow Dance with Secret Technique');
  });

  it('describes a hold rule as "<spells> held for <anchor>"', () => {
    expect(ruleLabel(HOLD_DANCE_FOR_BLADES)).toBe('Shadow Dance held for Shadow Blades');
  });
});

describe('rulesFollowed', () => {
  const pairDanceWithSecretTech: RulebookRule = {
    priority: 'warning', description: 'Pair Shadow Dance with Secret Technique', condition: DANCE_NEEDS_SECRET_TECH,
  };
  const holdDanceForBlades: RulebookRule = {
    priority: 'critical', description: 'Hold Shadow Dance for Shadow Blades', condition: HOLD_DANCE_FOR_BLADES,
  };

  it('lists the rule when Shadow Dance is paired with Secret Technique', () => {
    expect(rulesFollowed([pairDanceWithSecretTech], [cast(SHADOW_DANCE, 10), cast(SECRET_TECHNIQUE, 12)], 0))
      .toEqual(['Pair Shadow Dance with Secret Technique']);
  });

  it('omits the rule when Shadow Dance is cast without Secret Technique', () => {
    expect(rulesFollowed([pairDanceWithSecretTech], [cast(SHADOW_DANCE, 10), cast(SECRET_TECHNIQUE, 30)], 0)).toEqual([]);
  });

  it('omits the rule when Shadow Dance was never cast', () => {
    expect(rulesFollowed([pairDanceWithSecretTech], [cast(SECRET_TECHNIQUE, 12)], 0)).toEqual([]);
  });

  it('lists the rule when Shadow Dance is held clear of Shadow Blades', () => {
    // Shadow Blades at 10 and 120; the held Shadow Dance at 50 is outside [105,120).
    expect(rulesFollowed([holdDanceForBlades], [cast(SHADOW_BLADES, 10), cast(SHADOW_BLADES, 120), cast(SHADOW_DANCE, 50)], 0))
      .toEqual(['Hold Shadow Dance for Shadow Blades']);
  });

  it('omits the rule when Shadow Dance is spent in the hold window before Shadow Blades', () => {
    expect(rulesFollowed([holdDanceForBlades], [cast(SHADOW_BLADES, 10), cast(SHADOW_BLADES, 120), cast(SHADOW_DANCE, 110)], 0)).toEqual([]);
  });

  it('omits the rule when the held cooldown was never cast', () => {
    expect(rulesFollowed([holdDanceForBlades], [cast(SHADOW_BLADES, 10), cast(SHADOW_BLADES, 120)], 0)).toEqual([]);
  });

  it('omits the rule with only a single Shadow Blades cast', () => {
    expect(rulesFollowed([holdDanceForBlades], [cast(SHADOW_BLADES, 10), cast(SHADOW_DANCE, 5)], 0)).toEqual([]);
  });

  it('skips rules without a condition', () => {
    expect(rulesFollowed([{ description: 'r', condition: null }], [cast(SHADOW_DANCE, 1)], 0)).toEqual([]);
  });
});

/* ----------------------------- offensive analysis ----------------------------- */

describe('analyzeRotationFindings', () => {
  it('emits a lost-cooldown critical when never used and expected', () => {
    const findings = analyzeRotationFindings(scan({ bench: bench() }));
    const lost = findings.find(f => f.category === 'lost_cooldown');
    expect(lost?.severity).toBe('critical');
  });

  it('emits a success when used on cd and BL-aligned', () => {
    const casts = [cast(SHADOW_BLADES, 6)];
    const buffs = [buff(BLOODLUST, 6)];
    const single = bench({ per_cd_benchmarks: { 'Shadow Blades': cdBench({ uses_per_min: { avg: 0.5, stddev: 0.1, min: 0.4, max: 0.6 } }) } });
    const findings = analyzeRotationFindings(scan({ castEvents: casts, buffEvents: buffs, bench: single }));
    const success = findings.find(f => f.category === 'cooldown_usage' && f.severity === 'success');
    expect(success).toBeDefined();
    expect(success!.message).toContain('BL-aligned');
  });

  it('flags a late opener', () => {
    const casts = [cast(SHADOW_BLADES, 40)];
    const buffs = [buff(BLOODLUST, 38)];
    const findings = analyzeRotationFindings(scan({ castEvents: casts, buffEvents: buffs, bench: bench() }));
    expect(findings.some(f => f.category === 'cooldown_delay')).toBe(true);
  });

  it('gives the cast-efficiency finding a label and a remedy so the row is not blank', () => {
    const casts = [cast(SHADOW_BLADES, 6), cast(SHADOW_BLADES, 12)];
    const findings = analyzeRotationFindings(scan({ castEvents: casts, bench: bench() }));
    const efficiency = findings.find(f => f.category === 'cast_efficiency');
    expect(efficiency).toBeDefined();
    expect(efficiency!.label).toBeTruthy();
    expect(efficiency!.details?.remedy).toBeTruthy();
  });
});

describe('analyzeRotationFindings hold suggestions (prior-relative)', () => {
  const holdBench = bench({
    per_cd_benchmarks: { 'Shadow Blades': cdBench({
      hold_targets: { '2': { target_s: 130, stddev_s: 5, delay_s: 30, delay_stddev_s: 3, band_s: 5, effective_cd_s: 90, count: 4, total_samples: 5 } },
    }) },
  });

  it('flags an under-hold below the consensus band', () => {
    // gap 100, effective_cd 90 -> playerDelay 10 < (delay 30 - band 5 = 25).
    const casts = [cast(SHADOW_BLADES, 0), cast(SHADOW_BLADES, 100)];
    const findings = analyzeRotationFindings(scan({ castEvents: casts, bench: holdBench }));
    expect(findings.some(f => f.category === 'hold_suggestion')).toBe(true);
  });

  it('does not flag a player exactly at the band edge (strict)', () => {
    // gap 115 -> playerDelay 25, exactly delay - band; strict < so not flagged.
    const casts = [cast(SHADOW_BLADES, 0), cast(SHADOW_BLADES, 115)];
    const findings = analyzeRotationFindings(scan({ castEvents: casts, bench: holdBench }));
    expect(findings.some(f => f.category === 'hold_suggestion')).toBe(false);
  });

  it('does not flag an over-hold', () => {
    const casts = [cast(SHADOW_BLADES, 0), cast(SHADOW_BLADES, 160)];
    const findings = analyzeRotationFindings(scan({ castEvents: casts, bench: holdBench }));
    expect(findings.some(f => f.category === 'hold_suggestion')).toBe(false);
  });

  it('skips pre-v2 hold targets that lack the prior-relative band', () => {
    const oldBench = bench({ per_cd_benchmarks: { 'Shadow Blades': cdBench({
      hold_targets: { '2': { target_s: 130, stddev_s: 5, count: 4, total_samples: 5 } },
    }) } });
    const casts = [cast(SHADOW_BLADES, 0), cast(SHADOW_BLADES, 100)];
    const findings = analyzeRotationFindings(scan({ castEvents: casts, bench: oldBench }));
    expect(findings.some(f => f.category === 'hold_suggestion')).toBe(false);
  });
});

/* ----------------------------- per-cooldown checks ----------------------------- */

describe('checkLostUses', () => {
  const FIGHT_S = 120;

  it('flags a critical when a cooldown is never used but expected', () => {
    // 0 casts, expected 2 -> lost.
    const finding = checkLostUses('Shadow Blades', 0, 2, 2, FIGHT_S);
    expect(finding?.severity).toBe('critical');
  });

  it('flags a critical when used below the floor', () => {
    // 1 cast, floor 2 -> 1 lost.
    expect(checkLostUses('Shadow Blades', 1, 2, 2, FIGHT_S)?.category).toBe('lost_cooldown');
  });

  it('does not flag a cast exactly at the floor (strict)', () => {
    // 2 casts, floor 2 -> actual < floor is false.
    expect(checkLostUses('Shadow Blades', 2, 2, 2, FIGHT_S)).toBeNull();
  });
});

describe('checkFirstCastDelay', () => {
  // cdBench: avg_first_cast_s 5, stddev 2 -> outlier above 5 + 2*2 = 9s.
  const ONE_SEC_MS = 1000;

  it('flags a first cast more than 2 sigma past the top open', () => {
    // first cast at 10s > 9s threshold.
    expect(checkFirstCastDelay('Shadow Blades', [10 * ONE_SEC_MS], cdBench())?.category).toBe('cooldown_delay');
  });

  it('does not flag a first cast exactly at the 2-sigma boundary (strict)', () => {
    // first cast at 9s == threshold; strict > so not flagged.
    expect(checkFirstCastDelay('Shadow Blades', [9 * ONE_SEC_MS], cdBench())).toBeNull();
  });

  it('returns null with no casts', () => {
    expect(checkFirstCastDelay('Shadow Blades', [], cdBench())).toBeNull();
  });
});

describe('checkBloodlustAlignment', () => {
  const ONE_SEC_MS = 1000;
  const BL_AT_S = 10;
  // BL window: 30s before BL to 40s duration + 15s trail -> [-30, +55] around BL_AT_S = [-20, 65].

  it('flags a BL miss when the cooldown lands outside the window and parsers align it', () => {
    // cast at 100s is outside [-20, 65]; wantsBL true.
    const out = checkBloodlustAlignment('Shadow Blades', [100 * ONE_SEC_MS], cdBench(), BL_AT_S, true);
    expect(out.blAligned).toBe(false);
    expect(out.findings[0]?.measured).toEqual({ value: 'missed', unit: 'BL' });
  });

  it('does not flag a miss when parsers do not align it', () => {
    const out = checkBloodlustAlignment('Shadow Blades', [100 * ONE_SEC_MS], cdBench(), BL_AT_S, false);
    expect(out.blAligned).toBe(false);
    expect(out.findings).toEqual([]);
  });

  it('flags an in-window offset more than 2 sigma off the top offset', () => {
    // avg_bl_offset 0, stddev 2 -> outlier beyond |offset| > 4. Cast at BL+5s -> offset 5.
    const out = checkBloodlustAlignment('Shadow Blades', [(BL_AT_S + 5) * ONE_SEC_MS], cdBench(), BL_AT_S, true);
    expect(out.blAligned).toBe(true);
    expect(out.findings[0]?.measured).toEqual({ value: 'late', unit: 'in BL' });
  });

  it('does not flag an in-window offset exactly at the 2-sigma boundary (strict)', () => {
    // offset exactly 4 == 2*stddev; strict so not flagged.
    const out = checkBloodlustAlignment('Shadow Blades', [(BL_AT_S + 4) * ONE_SEC_MS], cdBench(), BL_AT_S, true);
    expect(out.blAligned).toBe(true);
    expect(out.findings).toEqual([]);
  });

  it('returns not-aligned with no BL', () => {
    expect(checkBloodlustAlignment('Shadow Blades', [5 * ONE_SEC_MS], cdBench(), null, true))
      .toEqual({ blAligned: false, findings: [] });
  });
});

describe('checkGaps', () => {
  const ONE_SEC_MS = 1000;
  // cdBench: avg_gap_s 90, stddev 5 -> outlier above 90 + 2*5 = 100s.

  it('flags a gap more than 2 sigma above the top gap', () => {
    // gap 0 -> 110 == 110s > 100s.
    expect(checkGaps('Shadow Blades', [0, 110 * ONE_SEC_MS], cdBench())).toHaveLength(1);
  });

  it('does not flag a gap exactly at the 2-sigma boundary (strict)', () => {
    // gap 0 -> 100 == 100s threshold; strict > so not flagged.
    expect(checkGaps('Shadow Blades', [0, 100 * ONE_SEC_MS], cdBench())).toEqual([]);
  });

  it('returns nothing when the bench has no gap stats', () => {
    expect(checkGaps('Shadow Blades', [0, 200 * ONE_SEC_MS], cdBench({ avg_gap_s: null, stddev_gap_s: null }))).toEqual([]);
  });
});

describe('checkHoldSuggestions', () => {
  const ONE_SEC_MS = 1000;
  const holdCd = cdBench({
    hold_targets: { '2': { target_s: 130, stddev_s: 5, delay_s: 30, delay_stddev_s: 3, band_s: 5, effective_cd_s: 90, count: 4, total_samples: 5 } },
  });

  it('flags an under-hold below the consensus band', () => {
    // gap 100, effective_cd 90 -> playerDelay 10 < (delay 30 - band 5 = 25).
    expect(checkHoldSuggestions('Shadow Blades', [0, 100 * ONE_SEC_MS], holdCd)).toHaveLength(1);
  });

  it('does not flag a player exactly at the band edge (strict)', () => {
    // gap 115 -> playerDelay 25 == delay - band; strict < so not flagged.
    expect(checkHoldSuggestions('Shadow Blades', [0, 115 * ONE_SEC_MS], holdCd)).toEqual([]);
  });
});

describe('checkCastEfficiency', () => {
  const ONE_SEC_MS = 1000;

  it('flags low cast efficiency past the idle floor', () => {
    // gap 0 -> 12s is one big idle gap (> downtime floor 1500ms and > 5s idle floor).
    const finding = checkCastEfficiency([0, 12 * ONE_SEC_MS], 120, bench());
    expect(finding?.category).toBe('cast_efficiency');
    expect(finding?.details?.remedy).toBeTruthy();
  });

  it('does not flag when total idle is at or below the floor (strict)', () => {
    // single 5s gap == MIN_IDLE_FOR_EFFICIENCY_S; strict > so not flagged.
    expect(checkCastEfficiency([0, 5 * ONE_SEC_MS], 120, bench())).toBeNull();
  });

  it('returns null with fewer than two casts', () => {
    expect(checkCastEfficiency([0], 120, bench())).toBeNull();
  });
});

describe('analyzeOneCooldown', () => {
  const ONE_SEC_MS = 1000;
  const cd = { name: 'Shadow Blades', spell_id: SHADOW_BLADES, cooldown: 90, align_with_bloodlust: true };
  const single = cdBench({ uses_per_min: { avg: 0.5, stddev: 0.1, min: 0.4, max: 0.6 } });

  it('skips a talent-gated cooldown that was never used', () => {
    expect(analyzeOneCooldown({ ...cd, talent_gated: true }, [], single, 120, null)).toBeNull();
  });

  it('reports success when a cooldown is used cleanly and BL-aligned', () => {
    // first cast 6s (under 9s open threshold), BL at 6s -> aligned.
    const result = analyzeOneCooldown(cd, [6 * ONE_SEC_MS], single, 120, 6);
    expect(result?.scan.issues).toEqual([]);
    expect(result?.success?.message).toContain('BL-aligned');
  });

  it('reports an issue (no success) when the opener is late', () => {
    const result = analyzeOneCooldown(cd, [40 * ONE_SEC_MS], single, 120, 38);
    expect(result?.success).toBeNull();
    expect(result?.scan.issues.some(finding => finding.category === 'cooldown_delay')).toBe(true);
  });
});

describe('bucketRotationFindings', () => {
  const abilities = { [SHADOW_BLADES]: { icon: 'sb', name: 'Shadow Blades' }, [VANISH]: { icon: 'vanish', name: 'Vanish' } };
  it('splits rule rows, cd issue rows and on-plan chips', () => {
    const findings: AnalysisFinding[] = [
      { severity: 'critical', category: 'rule_violation', label: 'Shadow Dance without Secret Technique', message: '', measured: { value: '1 / 1' }, details: { remedy: 'fix' } },
      { severity: 'warning', category: 'cooldown_delay', cd_name: 'Shadow Blades', message: '', measured: { value: '+3s' }, timestamp_ms: 4000 },
      { severity: 'success', category: 'cooldown_usage', cd_name: 'Vanish', message: '' },
    ];
    const out = bucketRotationFindings(findings, { 'Shadow Blades': SHADOW_BLADES, 'Vanish': VANISH }, abilities);
    expect(out.ruleRows).toHaveLength(1);
    expect(out.ruleRows[0].what).toBe('Shadow Dance without Secret Technique');
    expect(out.offensiveRows).toHaveLength(1);
    expect(out.offensiveRows[0]).toMatchObject({ name: 'Shadow Blades', spellId: SHADOW_BLADES, icon: 'sb', chip: 'held' });
    expect(out.onPlan).toEqual([{ name: 'Vanish', spellId: VANISH, icon: 'vanish' }]);
  });

  it('does not put a cooldown with issues on plan even if it also has a success', () => {
    const findings: AnalysisFinding[] = [
      { severity: 'critical', category: 'lost_cooldown', cd_name: 'Shadow Blades', message: '', measured: { value: '0 / 2' } },
      { severity: 'success', category: 'cooldown_usage', cd_name: 'Shadow Blades', message: '' },
    ];
    const out = bucketRotationFindings(findings, { 'Shadow Blades': SHADOW_BLADES }, abilities);
    expect(out.onPlan).toEqual([]);
    expect(out.offensiveRows).toHaveLength(1);
  });
});

describe('bucketRotationFindings passes', () => {
  const abilities = { [SHADOW_BLADES]: { icon: 'sb', name: 'Shadow Blades' }, [VANISH]: { icon: 'vanish', name: 'Vanish' } };
  const ruleFinding: AnalysisFinding = { severity: 'critical', category: 'rule_violation', label: 'Dance without Secret Technique', message: '', measured: { value: '1 / 1' }, details: { remedy: 'fix' } };
  const issueFinding: AnalysisFinding = { severity: 'warning', category: 'cooldown_delay', cd_name: 'Shadow Blades', message: '', measured: { value: '+3s' }, timestamp_ms: 4000 };
  const holdFinding: AnalysisFinding = { severity: 'info', category: 'hold_suggestion', message: '', measured: { value: '1:00' }, details: { cd_name: 'Shadow Blades', remedy: 'hold' } };
  const successFinding: AnalysisFinding = { severity: 'success', category: 'cooldown_usage', cd_name: 'Vanish', message: '' };

  it('partitions rule findings, per-cd buckets, and success names', () => {
    const partition = partitionRotationFindings([ruleFinding, issueFinding, holdFinding, successFinding]);
    expect(partition.ruleFindings).toEqual([ruleFinding]);
    expect(partition.byName['Shadow Blades'].issues).toEqual([issueFinding]);
    expect(partition.byName['Shadow Blades'].holds).toEqual([holdFinding]);
    expect([...partition.successNames]).toEqual(['Vanish']);
  });

  it('builds a rule row carrying the finding label and remedy', () => {
    const rows = buildRuleRows([ruleFinding]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ what: 'Dance without Secret Technique', fix: 'fix' });
  });

  it('builds offensive rows with resolved icon + chip per finding', () => {
    const rows = buildOffensiveRows({ 'Shadow Blades': { issues: [issueFinding], holds: [] } }, { 'Shadow Blades': SHADOW_BLADES }, abilities);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'Shadow Blades', spellId: SHADOW_BLADES, icon: 'sb', chip: 'held' });
  });

  it('builds on-plan chips only for clean successes', () => {
    const clean = partitionRotationFindings([successFinding]);
    expect(buildOnPlanChips(clean, { 'Vanish': VANISH }, abilities)).toEqual([{ name: 'Vanish', spellId: VANISH, icon: 'vanish' }]);
    // A success that also has an issue is not on plan.
    const dirty = partitionRotationFindings([successFinding, { ...issueFinding, cd_name: 'Vanish' }]);
    expect(buildOnPlanChips(dirty, { 'Vanish': VANISH }, abilities)).toEqual([]);
  });
});

describe('buildCdPlan', () => {
  const abilities = { [VANISH]: { icon: 'vanish', name: 'Vanish' }, [SHADOW_BLADES]: { icon: 'sb', name: 'Shadow Blades' } };
  it('orders by opener priority and surfaces holds for majority-hold cds', () => {
    const cooldowns = [
      { name: 'Vanish', spell_id: VANISH, cooldown: 120, opener_priority: 2, usage_rule: 'late' },
      { name: 'Shadow Blades', spell_id: SHADOW_BLADES, cooldown: 90, opener_priority: 1, align_with_bloodlust: true, usage_rule: 'open' },
    ];
    const benchmarks = {
      'Shadow Blades': cdBench({ majority_hold: true, hold_targets: { '2': { target_s: 100, stddev_s: 5, count: 4, total_samples: 5 } } }),
      'Vanish': cdBench({ avg_first_cast_s: 20 }),
    };
    const plan = buildCdPlan(cooldowns, benchmarks, abilities);
    expect(plan.map(p => p.name)).toEqual(['Shadow Blades', 'Vanish']);
    expect(plan[0].holds).toEqual([{ castIndex: 2, targetS: 100 }]);
    expect(plan[0].bloodlust).toBe(true);
    expect(plan[0].bloodlustPct).toBe(100);
  });

  it('drives the Bloodlust badge from bl_pct, not the rulebook flag', () => {
    const cooldowns = [
      { name: 'Aligned', spell_id: SHADOW_BLADES, cooldown: 90, align_with_bloodlust: false },
      { name: 'Unaligned', spell_id: VANISH, cooldown: 120, align_with_bloodlust: true },
    ];
    const benchmarks = {
      Aligned: cdBench({ bl_pct: 50 }),    // flag false, but data says aligned -> badge on (50 boundary)
      Unaligned: cdBench({ bl_pct: 49 }),  // flag true, but data says not -> badge off
    };
    const plan = buildCdPlan(cooldowns, benchmarks, abilities);
    const aligned = plan.find(p => p.name === 'Aligned')!;
    const unaligned = plan.find(p => p.name === 'Unaligned')!;
    expect(aligned.bloodlust).toBe(true);
    expect(aligned.bloodlustPct).toBe(50);
    expect(unaligned.bloodlust).toBe(false);
    expect(unaligned.bloodlustPct).toBeNull();
  });
});

/* ----------------------------- feature service ----------------------------- */

function withSource(value: RotationBench | null, wcl?: unknown): RotationFeatureService {
  const source: DataSource<RotationBench> = { getBench: () => Promise.resolve(value) };
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
    expect(view).toEqual({ ruleRows: [], ruleOnPlan: [], offensiveRows: [], onPlan: [] });
  });

  it('computes player findings from the player log', async () => {
    const wcl = {
      getReport: async () => ({
        title: 't', fights: [{ id: 1, name: 'Boss', startTime: 0, endTime: 120_000 }],
        masterData: { actors: [], abilities: [{ gameID: SHADOW_BLADES, name: 'Shadow Blades', icon: 'sb' }] },
      }),
      getAllEvents: async (_c: string, _f: number, dataType: string) =>
        dataType === 'Casts' ? [cast(SHADOW_BLADES, 6)] : [buff(BLOODLUST, 6)],
    };
    const single = bench({ per_cd_benchmarks: { 'Shadow Blades': cdBench({ uses_per_min: { avg: 0.5, stddev: 0.1, min: 0.4, max: 0.6 } }) } });
    const service = withSource(single, wcl);
    const view = await service.loadPlayerView('SubtletyRogue', 1, 'rX', 1, 10);
    expect(view.onPlan).toEqual([{ name: 'Shadow Blades', spellId: SHADOW_BLADES, icon: 'sb' }]);
  });

  it('returns bench-only plan rows for the pre-fight view', async () => {
    const service = withSource(bench({
      per_cd_benchmarks: { 'Shadow Blades': cdBench() },
    }));
    const rows = await service.loadPlanView('SubtletyRogue', 1);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Shadow Blades');
    expect(rows[0].icon).toBe('sb');
  });
});
