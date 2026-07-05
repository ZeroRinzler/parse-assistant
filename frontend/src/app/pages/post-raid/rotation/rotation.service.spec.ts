import { describe, it, expect } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { WclApiService } from '../../../core/services/wcl-api';
import { DataFileApiService } from '../../../core/services/data-file-api';
import { AnalysisFinding } from '../../../core/models/analysis.models';
import { PerCdBenchmark } from '../../../core/models/encounter.models';
import { RulebookRule, CastWithoutPriorCondition, HoldCooldownForAnchorCondition } from '../../../core/models/rulebook.models';
import { SHADOW_BLADES, SHADOW_DANCE, SECRET_TECHNIQUE, VANISH, BLOODLUST } from '../../../../testing/spell-ids';
import { cast, applyBuff } from '../../../../testing/builders/events';
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

// The check* and analyzeOneCooldown functions take cast times in ms.
const ONE_SEC_MS = 1000;

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
    bl_pct: 100, majority_hold: false, hold_targets: {}, sample_count: 5, used_sample_count: 5,
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
    const buffs = [applyBuff(BLOODLUST, 6)];
    const single = bench({ per_cd_benchmarks: { 'Shadow Blades': cdBench({ uses_per_min: { avg: 0.5, stddev: 0.1, min: 0.4, max: 0.6 } }) } });
    const findings = analyzeRotationFindings(scan({ castEvents: casts, buffEvents: buffs, bench: single }));
    const success = findings.find(f => f.category === 'cooldown_usage' && f.severity === 'success');
    expect(success).toBeDefined();
    expect(success!.message).toContain('BL-aligned');
  });

  it('flags a late opener', () => {
    const casts = [cast(SHADOW_BLADES, 40)];
    const buffs = [applyBuff(BLOODLUST, 38)];
    const findings = analyzeRotationFindings(scan({ castEvents: casts, buffEvents: buffs, bench: bench() }));
    expect(findings.some(f => f.category === 'cooldown_delay')).toBe(true);
  });

  it('gives the cast-efficiency finding a label and a remedy so the row is not blank', () => {
    // A 24s idle gap on the 120s scan fight = 80% efficiency, below the 87% (top avg 90 minus
    // 1 sigma) warn threshold.
    const FIRST_CAST_S = 6;
    const LATE_CAST_S = 30;
    const casts = [cast(SHADOW_BLADES, FIRST_CAST_S), cast(SHADOW_BLADES, LATE_CAST_S)];
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
  const FIGHT_DUR_S = 120;
  // bench(): top_avg_efficiency 90%, top_efficiency_stddev 3% -> the warn threshold is 1 sigma
  // under, i.e. below 87%. efficiency% = (1 - idleS / FIGHT_DUR_S) * 100.
  const TOP_AVG_PCT = 90;
  const WARN_THRESHOLD_PCT = TOP_AVG_PCT - 3;  // top avg minus 1 sigma
  // Idle spans chosen relative to the threshold. Each is a single gap > the 1.5s downtime floor.
  const IDLE_BELOW_BAND_S = 20;   // -> 83.3%, below WARN_THRESHOLD_PCT
  const IDLE_FAR_BELOW_S = 60;    // -> 50%, far below the band
  const IDLE_AT_TOP_AVG_S = 12;   // -> 90% == top avg, inside the band
  const IDLE_ABOVE_AVG_MS = 1600; // just over the 1.5s downtime floor -> 98.7%, above top avg

  it('flags low cast efficiency more than 1 sigma below the top parses', () => {
    const finding = checkCastEfficiency([0, IDLE_BELOW_BAND_S * ONE_SEC_MS], FIGHT_DUR_S, bench());
    expect(finding?.category).toBe('cast_efficiency');
    expect(finding?.severity).toBe('warning');
    expect(finding?.details?.remedy).toBeTruthy();
  });

  it('never escalates to critical, however far below', () => {
    expect(checkCastEfficiency([0, IDLE_FAR_BELOW_S * ONE_SEC_MS], FIGHT_DUR_S, bench())?.severity).toBe('warning');
  });

  it('does not flag efficiency within 1 sigma of the top average', () => {
    // At the top average, inside the band -> no finding (no fixed idle floor anymore).
    expect(WARN_THRESHOLD_PCT).toBeLessThan(TOP_AVG_PCT); // the band has width, so the top avg is inside it
    expect(checkCastEfficiency([0, IDLE_AT_TOP_AVG_S * ONE_SEC_MS], FIGHT_DUR_S, bench())).toBeNull();
  });

  it('does not flag when the player beats the top parses', () => {
    expect(checkCastEfficiency([0, IDLE_ABOVE_AVG_MS], FIGHT_DUR_S, bench())).toBeNull();
  });

  it('returns null with fewer than two casts', () => {
    expect(checkCastEfficiency([0], FIGHT_DUR_S, bench())).toBeNull();
  });
});

describe('analyzeOneCooldown', () => {
  const FIGHT_DUR_S = 120;
  const UPM = { avg: 0.5, stddev: 0.1, min: 0.4, max: 0.6 };  // top-parse uses-per-minute
  const cd = { name: 'Shadow Blades', spell_id: SHADOW_BLADES, cooldown: 90, align_with_bloodlust: true };
  const single = cdBench({ uses_per_min: UPM });
  // A cooldown a minority of top parses use: used/sample below MIN_USE_SHARE_FRAC (0.5).
  const TOTAL_SAMPLED = 10;
  const MINORITY_USERS = 2;  // 2/10 = 20%
  const rareUse = cdBench({ sample_count: TOTAL_SAMPLED, used_sample_count: MINORITY_USERS, uses_per_min: UPM });

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

  it('does not flag an unused cooldown that only a minority of top parses use (use-share gate)', () => {
    // Matching the top parses by not pressing it is not a lost cast.
    const result = analyzeOneCooldown(cd, [], rareUse, FIGHT_DUR_S, null);
    expect(result?.scan.issues).toEqual([]);
    expect(result?.success).toBeNull();
  });

  it('does not flag a late opener of a minority-use cooldown (use-share gate)', () => {
    // Opened well past 2 sigma over the 5s top first cast, but the first-cast check is gated off.
    const LATE_OPENER_S = 40;
    const result = analyzeOneCooldown(cd, [LATE_OPENER_S * ONE_SEC_MS], rareUse, FIGHT_DUR_S, null);
    expect(result?.scan.issues.some(finding => finding.category === 'cooldown_delay')).toBe(false);
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
});

describe('rotation finding partition and row builders', () => {
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
      'Shadow Blades': cdBench({ majority_hold: true, hold_targets: { '2': { target_s: 100, stddev_s: 5, delay_s: 10, delay_stddev_s: 2, band_s: 5, effective_cd_s: 90, count: 4, total_samples: 5 } } }),
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

function withSource(value: RotationBench | null, wcl?: unknown, rules: RulebookRule[] = []): RotationFeatureService {
  const source: DataSource<RotationBench> = { getBench: () => Promise.resolve(value) };
  // The rotation rules are read from the authored rulebook (present regardless of ingest),
  // so the feature service also injects the pass-through DataFileApiService.
  const dataFiles: Pick<DataFileApiService, 'getRulebook'> = {
    getRulebook: () => Promise.resolve({ spec: 'SubtletyRogue', spec_icon: 'x', rules }),
  };
  TestBed.configureTestingModule({
    providers: [
      { provide: ROTATION_DATA_SOURCE, useValue: source },
      { provide: WclApiService, useValue: (wcl ?? {}) as WclApiService },
      { provide: DataFileApiService, useValue: dataFiles },
    ],
  });
  return TestBed.inject(RotationFeatureService);
}

describe('RotationFeatureService', () => {
  it('marks offensives unavailable and empty when the top-parse bench is absent', async () => {
    const service = withSource(null);
    const view = await service.loadPlayerView('SubtletyRogue', 1, 'rX', 1, 10);
    expect(view).toEqual({ available: false, ruleRows: [], ruleOnPlan: [], offensiveRows: [], onPlan: [] });
  });

  it('evaluates the rulebook rules even with no bench (offensives unavailable)', async () => {
    // A fresh tier: no top-parse bench, but the rulebook rules still grade the player's casts.
    const wcl = {
      getReport: async () => ({ title: 't', fights: [{ id: 1, name: 'Boss', startTime: 0, endTime: 120_000 }], masterData: { actors: [], abilities: [] } }),
      getAllEvents: async (_c: string, _f: number, dataType: string) =>
        dataType === 'Casts' ? [cast(SHADOW_DANCE, 10), cast(SECRET_TECHNIQUE, 30)] : [],
    };
    const rule: RulebookRule = { priority: 'critical', condition: DANCE_NEEDS_SECRET_TECH };
    const service = withSource(null, wcl, [rule]);
    const view = await service.loadPlayerView('SubtletyRogue', 1, 'rX', 1, 10);
    expect(view.available).toBe(false);
    expect(view.offensiveRows).toEqual([]);
    expect(view.ruleRows).toHaveLength(1);
    expect(view.ruleRows[0].what).toBe('Shadow Dance without Secret Technique');
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
    const single = bench({ per_cd_benchmarks: { 'Shadow Blades': cdBench({ uses_per_min: { avg: 0.5, stddev: 0.1, min: 0.4, max: 0.6 } }) } });
    const service = withSource(single, wcl);
    const view = await service.loadPlayerView('SubtletyRogue', 1, 'rX', 1, 10);
    expect(view.available).toBe(true);
    expect(view.onPlan).toEqual([{ name: 'Shadow Blades', spellId: SHADOW_BLADES, icon: 'sb' }]);
  });

  it('returns bench-only plan rows for the pre-fight view', async () => {
    const service = withSource(bench({
      per_cd_benchmarks: { 'Shadow Blades': cdBench() },
    }));
    const view = await service.loadPlanView('SubtletyRogue', 1);
    expect(view.available).toBe(true);
    expect(view.rows).toHaveLength(1);
    expect(view.rows[0].name).toBe('Shadow Blades');
    expect(view.rows[0].icon).toBe('sb');
  });

  it('marks the pre-fight plan unavailable when the bench is absent', async () => {
    const service = withSource(null);
    const view = await service.loadPlanView('SubtletyRogue', 1);
    expect(view).toEqual({ available: false, rows: [] });
  });
});
