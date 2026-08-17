import { assert, describe, it, expect } from 'vitest';
import {
  RulebookRule, RuleSeverity,
  CastWithoutPriorCondition, AuraUptimeBelowCondition,
  CastAtTargetCountCondition, ResourceAtCastCondition, ProcWastedCondition, SpendAtStacksCondition,
} from '../../../../core/models/rulebook.models';
import {
  SHADOW_BLADES, SHADOW_DANCE, SECRET_TECHNIQUE, RUPTURE, EVISCERATE, BLACK_POWDER,
  LIGHTNING_BOLT, MAELSTROM_WEAPON,
} from '../../../../../testing/spell-ids';
import { cast } from '../../../../../testing/builders/events';
import {
  COMBO_POINT_TYPE, FIELD_NEVER, HOLD_WINDOW_S,
  HOLD_DANCE_FOR_BLADES, SECRET_TECH_NEEDS_DANCE,
  band, benched, ruleCtx,
} from '../../../../../testing/rule-fixtures';
import { BenchedRule, RuleSample, RuleStream } from './engine-core';
import {
  benchedRules, evaluateRules, judgeableRules, ruleBand, ruleLabel, rulesFollowed, rulesNeed,
} from './engine';

describe('rule engine', () => {
  it('evaluateRules names a violated rule by its description, matching how rulesFollowed names it', () => {
    const description = 'Secret Technique always inside Shadow Dance';
    const rule: RulebookRule = { severity: 'warning', description, condition: SECRET_TECH_NEEDS_DANCE };
    const violated = evaluateRules([benched(rule)], ruleCtx([cast(SECRET_TECHNIQUE, 10)]));
    assert.exists(violated[0]);
    expect(violated[0].label).toBe(description);
    expect(rulesFollowed([benched(rule)], ruleCtx([cast(SHADOW_DANCE, 8), cast(SECRET_TECHNIQUE, 10)]))).toEqual([description]);
  });

  it('evaluateRules falls back to the synthesized label when a rule has no description', () => {
    const rule: RulebookRule = { severity: 'warning', condition: SECRET_TECH_NEEDS_DANCE };
    const finding = evaluateRules([benched(rule)], ruleCtx([cast(SECRET_TECHNIQUE, 10)]))[0];
    assert.exists(finding);
    expect(finding.label).toBe('Secret Technique without Shadow Dance');
  });

  it('evaluateRules carries the rule type onto the finding', () => {
    const rule: RulebookRule = { type: 'cooldown_pairing', severity: 'warning', condition: SECRET_TECH_NEEDS_DANCE };
    const findings = evaluateRules([benched(rule)], ruleCtx([cast(SECRET_TECHNIQUE, 10)]));
    assert.exists(findings[0]);
    expect(findings[0].rule_type).toBe('cooldown_pairing');
  });
});

describe('rule severity', () => {
  it.each(['critical', 'warning', 'info'] as RuleSeverity[])('carries an authored %s onto the finding', severity => {
    const rule: RulebookRule = { severity, condition: SECRET_TECH_NEEDS_DANCE };
    const finding = evaluateRules([benched(rule)], ruleCtx([cast(SECRET_TECHNIQUE, 10)]))[0];
    assert.exists(finding);
    expect(finding.severity).toBe(severity);
  });
});

describe('ruleLabel', () => {
  it('prefers the rule description when present', () => {
    expect(ruleLabel(SECRET_TECH_NEEDS_DANCE, 'Pair Shadow Dance with Secret Technique'))
      .toBe('Pair Shadow Dance with Secret Technique');
  });
});

describe('rulesFollowed', () => {
  const pairDanceWithSecretTech: RulebookRule = {
    severity: 'warning', description: 'Pair Shadow Dance with Secret Technique', condition: SECRET_TECH_NEEDS_DANCE,
  };
  const holdDanceForBlades: RulebookRule = {
    severity: 'critical', description: 'Hold Shadow Dance for Shadow Blades', condition: HOLD_DANCE_FOR_BLADES,
  };

  it('lists the rule when Shadow Dance is paired with Secret Technique', () => {
    expect(rulesFollowed([benched(pairDanceWithSecretTech)], ruleCtx([cast(SHADOW_DANCE, 10), cast(SECRET_TECHNIQUE, 12)])))
      .toEqual(['Pair Shadow Dance with Secret Technique']);
  });

  it('omits the rule when Shadow Dance is cast without Secret Technique', () => {
    expect(rulesFollowed([benched(pairDanceWithSecretTech)], ruleCtx([cast(SHADOW_DANCE, 10), cast(SECRET_TECHNIQUE, 30)]))).toEqual([]);
  });

  it('omits the rule when Secret Technique was never cast', () => {
    expect(rulesFollowed([benched(pairDanceWithSecretTech)], ruleCtx([cast(SHADOW_DANCE, 12)]))).toEqual([]);
  });

  it('lists the rule when Shadow Dance is held clear of Shadow Blades', () => {
    // Shadow Blades at 10 and 120; the held Shadow Dance at 50 is outside [105,120) and inside the field's own ceiling.
    const wideCeiling = band(HOLD_WINDOW_S, 100);
    expect(rulesFollowed([benched(holdDanceForBlades, wideCeiling)], ruleCtx([cast(SHADOW_BLADES, 10), cast(SHADOW_BLADES, 120), cast(SHADOW_DANCE, 50)])))
      .toEqual(['Hold Shadow Dance for Shadow Blades']);
  });

  it('omits the rule when Shadow Dance is spent in the hold window before Shadow Blades', () => {
    expect(rulesFollowed([benched(holdDanceForBlades, band(HOLD_WINDOW_S))], ruleCtx([cast(SHADOW_BLADES, 10), cast(SHADOW_BLADES, 120), cast(SHADOW_DANCE, 110)]))).toEqual([]);
  });

  it('omits the rule when the held cooldown was never cast', () => {
    expect(rulesFollowed([benched(holdDanceForBlades, band(HOLD_WINDOW_S))], ruleCtx([cast(SHADOW_BLADES, 10), cast(SHADOW_BLADES, 120)]))).toEqual([]);
  });

  it('omits the rule with only a single Shadow Blades cast', () => {
    expect(rulesFollowed([benched(holdDanceForBlades, band(HOLD_WINDOW_S))], ruleCtx([cast(SHADOW_BLADES, 10), cast(SHADOW_DANCE, 5)]))).toEqual([]);
  });
});

describe('judgeableRules', () => {
  // A deployed rulebook file carrying rules the types alone cannot rule out.
  const unconformed = [{ description: 'no condition' }, { description: 'null condition', condition: null }] as unknown as RulebookRule[];

  it('drops rules the engine cannot judge, so a non-conforming file cannot crash it', () => {
    expect(judgeableRules(unconformed)).toEqual([]);
  });

  it('keeps every rule that carries a condition', () => {
    const rule: RulebookRule = { severity: 'warning', description: 'real', condition: SECRET_TECH_NEEDS_DANCE };
    expect(judgeableRules([...unconformed, rule])).toEqual([rule]);
  });
});

describe('ruleBand', () => {
  const sample = (values: number[], unmeasuredOut = 0): RuleSample => ({ values, unmeasuredOut });
  const samples = (perParse: number[][]) => perParse.map(values => sample(values));
  const instanceCond: SpendAtStacksCondition = {
    kind: 'spend_at_stacks', spell_id: LIGHTNING_BOLT, spell_name: 'Lightning Bolt',
    buff_spell_id: MAELSTROM_WEAPON, buff_spell_name: 'Maelstrom Weapon', bound: 'min', max_stacks: 10,
  };
  const parseCond: AuraUptimeBelowCondition = {
    kind: 'aura_uptime_below', aura_spell_id: RUPTURE, aura_spell_name: 'Rupture', on: 'target',
  };

  it('pools every instance across parses into one field, not each parse\'s own median', () => {
    // 5 parses x 4 instances = 20 pooled: 16 at 1 and 4 at 100. Pooling medians ([100,1,1,1,1]) would read a far lower p90.
    const perParse = samples([[100, 100, 100, 100], [1, 1, 1, 1], [1, 1, 1, 1], [1, 1, 1, 1], [1, 1, 1, 1]]);
    const result = ruleBand(instanceCond, perParse);
    expect(result.sample_count).toBe(20);
    expect(result.band?.hi).toBe(100);
    expect(result.band?.lo).toBe(1);
  });

  it('counts sample_count as pooled instances, for an instance-pooled kind', () => {
    const perParse = samples(Array.from({ length: 5 }, () => [1, 2, 3, 4, 5]));
    expect(ruleBand(instanceCond, perParse).sample_count).toBe(25);
  });

  it('leaves a parse that measured nothing out of the pool', () => {
    const result = ruleBand(parseCond, samples([[1], [2], [3], [], [4], [5]]));
    expect(result.sample_count).toBe(5);
  });

  it('reads a pool at MIN_POOLED_INSTANCES off its percentiles, and a thinner one off its own min and max', () => {
    // 5 parses x 4 instances = 20 pooled, values 1..20 dealt round-robin so no one parse owns an extreme.
    const thick = samples(Array.from({ length: 5 }, (_, p) => [0, 5, 10, 15].map(i => p + i + 1)));
    const thickBand = ruleBand(instanceCond, thick).band;
    expect(thickBand?.lo).toBeGreaterThan(1);
    expect(thickBand?.hi).toBeLessThan(20);
    // 10 pooled: a percentile here would just name the second-worst parse, so the edges are the field's own extremes.
    const thin = samples([[1, 2], [3, 4], [5, 6], [7, 8], [9, 10]]);
    expect(ruleBand(instanceCond, thin).band).toMatchObject({ lo: 1, hi: 10 });
  });

  it('bars a band below MIN_MEASURED_PARSES', () => {
    expect(ruleBand(parseCond, samples([[1], [2], [3], [4]])).band).toBeNull();
    expect(ruleBand(parseCond, samples([[1], [2], [3], [4], [5]])).band).not.toBeNull();
  });

  it('drops a rule whose kind needs bounds the rulebook never declared, rather than reading unknown as unbounded', () => {
    const noCap = { ...instanceCond, max_stacks: undefined } as unknown as SpendAtStacksCondition;
    const perParse = samples(Array.from({ length: 5 }, () => [1, 2, 3, 4, 5]));
    expect(ruleBand(noCap, perParse).band).toBeNull();
    expect(ruleBand(instanceCond, perParse).band).not.toBeNull();
  });

  it('keeps a two-sided rule whose near edge is degenerate, since its far edge still judges', () => {
    // Every spend at zero stacks: the floor has nothing under it, but the cap above it is still reachable.
    const perParse = samples(Array.from({ length: 5 }, () => [0, 0, 0, 0, 0]));
    expect(ruleBand(instanceCond, perParse).band).toMatchObject({ lo: 0, hi: 0 });
  });

  it('drops a two-sided rule only once BOTH edges are degenerate', () => {
    // p10 lands on the domain floor and p90 on the cap, so neither side has room left to flag.
    const perParse = samples(Array.from({ length: 5 }, () => [0, 0, 0, 10, 10]));
    expect(ruleBand(instanceCond, perParse).band).toBeNull();
  });

  it('drops a one-sided rule whose only edge lands on the domain maximum, since no cast can clear it', () => {
    const genAtCap: ResourceAtCastCondition = {
      kind: 'resource_at_cast', spell_id: EVISCERATE, spell_name: 'Eviscerate',
      resource_type: COMBO_POINT_TYPE, resource_name: 'combo points', bound: 'max',
    };
    const perParse = samples(Array.from({ length: 5 }, () => [1, 1, 1, 1, 1]));
    expect(ruleBand(genAtCap, perParse).band).toBeNull();
  });

  it('returns a null band once the field disagrees with its own edge past MAX_TOLERANCE', () => {
    // 8 clean parses in-band, 2 fully out: the p90 of per-parse shares [0*8,1,1] lands on the top pair.
    const bad = [0];
    const good = [100, 100, 100];
    const result = ruleBand(instanceCond, samples([bad, bad, good, good, good, good, good, good, good, good]));
    expect(result.sample_count).toBe(2 + 8 * 3);
    expect(result.band).toBeNull();
  });

  it('measures tolerance as the p90 of each contributing parse\'s own out-of-band share', () => {
    const oneOffParse = [0, 0, 50, 50];
    const cleanParse = [50, 50, 50, 50];
    const result = ruleBand(instanceCond, samples([oneOffParse, cleanParse, cleanParse, cleanParse, cleanParse]));
    expect(result.band?.tolerance).toBeCloseTo(0.3, 5);
  });

  it('counts an instance the parse judged but could not measure as out of band, so tolerance defends the population the runtime judges', () => {
    const pairedCond: CastWithoutPriorCondition = SECRET_TECH_NEEDS_DANCE;
    // Every parse pairs 3 casts tightly and leaves 1 unpaired: the field's own unpaired rate has to reach tolerance.
    const perParse = Array.from({ length: 5 }, () => sample([1, 1, 1], 1));
    const measuredOnly = Array.from({ length: 5 }, () => sample([1, 1, 1]));
    expect(ruleBand(pairedCond, perParse).band?.tolerance).toBeCloseTo(0.25, 5);
    expect(ruleBand(pairedCond, measuredOnly).band?.tolerance).toBe(0);
  });

  it('pins tolerance at exactly 0 for a parse-pooled kind, whose parses each contribute one value', () => {
    const wasted: ProcWastedCondition = {
      kind: 'proc_wasted', buff_spell_id: SHADOW_DANCE, buff_spell_name: 'Shadow Dance',
      spend_spell_ids: [SECRET_TECHNIQUE], spend_spell_names: ['Secret Technique'],
    };
    const perParse = samples(Array.from({ length: 10 }, (_, i) => [i / 10]));
    expect(ruleBand(wasted, perParse).band?.tolerance).toBe(0);
  });

  it('collapses lo and hi to the same value when every parse agrees exactly', () => {
    const blackPowder: CastAtTargetCountCondition = {
      kind: 'cast_at_target_count', spell_id: BLACK_POWDER, spell_name: 'Black Powder', bound: 'min',
    };
    const UNANIMOUS_TARGETS = 5;
    const perParse = samples(Array.from({ length: 5 }, () => Array.from({ length: 4 }, () => UNANIMOUS_TARGETS)));
    expect(ruleBand(blackPowder, perParse).band).toEqual({
      lo: UNANIMOUS_TARGETS, hi: UNANIMOUS_TARGETS, tolerance: 0,
    });
  });
});

describe('benchedRules', () => {
  const needsMagnitude: RulebookRule = { severity: 'warning', description: 'pair', condition: SECRET_TECH_NEEDS_DANCE };
  const procRule: RulebookRule = {
    severity: 'warning', description: 'proc',
    condition: {
      kind: 'proc_wasted', buff_spell_id: SHADOW_DANCE, buff_spell_name: 'Shadow Dance',
      spend_spell_ids: [SECRET_TECHNIQUE], spend_spell_names: ['Secret Technique'],
    },
  };

  it('keeps a rule whose band this encounter measured', () => {
    expect(benchedRules([benched(needsMagnitude)]).map(entry => entry.rule)).toEqual([needsMagnitude]);
  });

  it('drops a rule whose band the encounter could not measure, rather than inventing one', () => {
    expect(benchedRules([benched(needsMagnitude, null)])).toEqual([]);
  });

  it('drops an unbenched share rule too, since every kind is now judged against the field', () => {
    expect(benchedRules([benched(procRule, null)])).toEqual([]);
    expect(benchedRules([benched(procRule, FIELD_NEVER)]).map(entry => entry.rule)).toEqual([procRule]);
  });

  it('drops a rule with no condition before a band is even considered', () => {
    const unconformed = { rule: { description: 'none' }, band: null, sample_count: 0, parse_count: 0 } as unknown as BenchedRule;
    expect(benchedRules([unconformed])).toEqual([]);
  });

  it('drops a row still carrying the shape a residual deployed file bakes, since entry.band reads undefined on it', () => {
    const stale = { rule: needsMagnitude, threshold: { value: 5, band: 1 }, sample_count: 10 } as unknown as BenchedRule;
    expect(benchedRules([stale])).toEqual([]);
  });
});

describe('rulesNeed', () => {
  const uptime = (on: 'self' | 'target'): RulebookRule =>
    ({ severity: 'warning', condition: { kind: 'aura_uptime_below', aura_spell_id: RUPTURE, aura_spell_name: 'Rupture', on } });
  const targetCount: RulebookRule = {
    severity: 'warning',
    condition: { kind: 'cast_at_target_count', spell_id: BLACK_POWDER, spell_name: 'Black Powder', bound: 'min' },
  };

  const cases: { name: string; rules: RulebookRule[]; stream: RuleStream; needed: boolean }[] = [
    { name: 'an on-target uptime rule reads enemy auras', rules: [uptime('target')], stream: 'enemyAuras', needed: true },
    { name: 'an on-self uptime rule leaves them unfetched', rules: [uptime('self')], stream: 'enemyAuras', needed: false },
    { name: 'a target-count rule reads damage', rules: [targetCount], stream: 'damage', needed: true },
    { name: 'a rulebook with no rules leaves damage unfetched', rules: [], stream: 'damage', needed: false },
    { name: 'a rulebook with no rules leaves enemy auras unfetched', rules: [], stream: 'enemyAuras', needed: false },
  ];

  it.each(cases)('$name', ({ rules, stream, needed }) => {
    expect(rulesNeed(rules, stream)).toBe(needed);
  });
});
