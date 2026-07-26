import { describe, it, expect } from 'vitest';
import {
  RulebookRule, RuleSeverity,
  CastWithoutPriorCondition, HoldCooldownForAnchorCondition, CastOutsideBuffCondition,
  AuraUptimeBelowCondition, OpeningSequenceCondition,
  CastAtTargetCountCondition, ResourceAtCastCondition, ProcWastedCondition,
} from '../../../core/models/rulebook.models';
import { WclEvent } from '../../../core/models/wcl.models';
import {
  SHADOW_BLADES, SHADOW_DANCE, SECRET_TECHNIQUE, RUPTURE, EVISCERATE, BLACK_POWDER,
} from '../../../../testing/spell-ids';
import {
  cast, applyBuff, removeBuff, buffWindow, applyDebuff, removeDebuff, damage, death,
} from '../../../../testing/builders/events';
import {
  BenchedRule, RuleContext, RuleInputs, RuleStream, RuleThreshold,
  buildRuleContext, evaluateRules, rulesFollowed, ruleLabel, ruleApplicable,
  rulesNeed, judgeableRules, benchedRules, measureRule, ruleThreshold,
  evaluateCastWithoutPrior, evaluateHoldForAnchor, evaluateCastOutsideBuff, evaluateAuraUptimeBelow,
  evaluateOpeningSequence, evaluateCastAtTargetCount, evaluateResourceAtCast, evaluateProcWasted,
} from './rotation-rules';

// A zero band keeps the fixture arithmetic exact.
const PAIR_WINDOW_S = 5, HOLD_WINDOW_S = 15;
function thr(value: number, band = 0): RuleThreshold {
  return { value, band };
}

// A rule whose magnitude this encounter measured, so fixtures about something else are not gated on it.
function benched(rule: RulebookRule, threshold: RuleThreshold | null = thr(PAIR_WINDOW_S)): BenchedRule {
  return { rule, threshold, sample_count: threshold == null ? 0 : 10 };
}

// Build a RuleContext for a 0..120s fight from just the casts - keeps the rule call sites terse.
const RULE_FIGHT_END_MS = 120_000;
function ruleCtx(casts: WclEvent[], over: Partial<RuleInputs> = {}): RuleContext {
  return buildRuleContext({
    casts, buffs: [], debuffs: [], damage: [], deaths: [], fStart: 0, fEnd: RULE_FIGHT_END_MS,
    ...over,
  });
}

// Two real Subtlety rules reused across the evaluator and rules-followed specs.
const SECRET_TECH_NEEDS_DANCE: CastWithoutPriorCondition = {
  kind: 'cast_without_prior',
  spell_id: SECRET_TECHNIQUE, spell_name: 'Secret Technique',
  required_spell_id: SHADOW_DANCE, required_spell_name: 'Shadow Dance',
};
const HOLD_DANCE_FOR_BLADES: HoldCooldownForAnchorCondition = {
  kind: 'hold_cooldown_for_anchor',
  spell_ids: [SHADOW_DANCE], spell_names: ['Shadow Dance'],
  anchor_spell_id: SHADOW_BLADES, anchor_spell_name: 'Shadow Blades',
};

describe('rule engine', () => {
  it('flags Secret Technique cast with no Shadow Dance in window', () => {
    const castTimes = ruleCtx([cast(SHADOW_DANCE, 10), cast(SECRET_TECHNIQUE, 30)]);
    const finding = evaluateCastWithoutPrior(SECRET_TECH_NEEDS_DANCE, castTimes, thr(PAIR_WINDOW_S), 'warning', 'do x');
    expect(finding).not.toBeNull();
    expect(finding!.measured).toEqual({ value: '1 / 1', unit: 'cast(s)' });
    expect(finding!.details?.remedy).toBe('do x');
  });

  it('passes when Shadow Dance precedes Secret Technique inside the window', () => {
    const castTimes = ruleCtx([cast(SHADOW_DANCE, 10), cast(SECRET_TECHNIQUE, 12)]);
    expect(evaluateCastWithoutPrior(SECRET_TECH_NEEDS_DANCE, castTimes, thr(PAIR_WINDOW_S), 'warning')).toBeNull();
  });

  it('flags Shadow Dance spent in the hold window before Shadow Blades', () => {
    // Shadow Blades at 10 and 120; the second (120) is the one evaluated; Shadow Dance at 110 is within 15s.
    const castTimes = ruleCtx([cast(SHADOW_BLADES, 10), cast(SHADOW_BLADES, 120), cast(SHADOW_DANCE, 110)]);
    const finding = evaluateHoldForAnchor(HOLD_DANCE_FOR_BLADES, castTimes, thr(HOLD_WINDOW_S), 'critical');
    expect(finding).not.toBeNull();
    expect(finding!.measured).toEqual({ value: '1', unit: 'charge(s)' });
  });

  it('flags a required cast that only follows the judged one, because position defaults to before', () => {
    const castTimes = ruleCtx([cast(SECRET_TECHNIQUE, 10), cast(SHADOW_DANCE, 12)]);
    expect(evaluateCastWithoutPrior(SECRET_TECH_NEEDS_DANCE, castTimes, thr(PAIR_WINDOW_S), 'warning')).not.toBeNull();
  });

  it('accepts a required cast on either side when position is either', () => {
    const paired: CastWithoutPriorCondition = { ...SECRET_TECH_NEEDS_DANCE, position: 'either' };
    const danceAfter = ruleCtx([cast(SECRET_TECHNIQUE, 10), cast(SHADOW_DANCE, 12)]);
    const danceBefore = ruleCtx([cast(SHADOW_DANCE, 8), cast(SECRET_TECHNIQUE, 10)]);
    expect(evaluateCastWithoutPrior(paired, danceAfter, thr(PAIR_WINDOW_S), 'warning')).toBeNull();
    expect(evaluateCastWithoutPrior(paired, danceBefore, thr(PAIR_WINDOW_S), 'warning')).toBeNull();
  });

  it('requires the companion to follow when position is after', () => {
    const followUp: CastWithoutPriorCondition = { ...SECRET_TECH_NEEDS_DANCE, position: 'after' };
    const danceAfter = ruleCtx([cast(SECRET_TECHNIQUE, 10), cast(SHADOW_DANCE, 12)]);
    const danceBefore = ruleCtx([cast(SHADOW_DANCE, 8), cast(SECRET_TECHNIQUE, 10)]);
    expect(evaluateCastWithoutPrior(followUp, danceAfter, thr(PAIR_WINDOW_S), 'warning')).toBeNull();
    expect(evaluateCastWithoutPrior(followUp, danceBefore, thr(PAIR_WINDOW_S), 'warning')).not.toBeNull();
  });

  it('accepts a companion exactly on the window edge but not past it', () => {
    // window_s is 5, so a Shadow Dance at 5 covers a Secret Technique at 10 and one at 4.9 does not.
    const onEdge = ruleCtx([cast(SHADOW_DANCE, 5), cast(SECRET_TECHNIQUE, 10)]);
    const pastEdge = ruleCtx([cast(SHADOW_DANCE, 4.9), cast(SECRET_TECHNIQUE, 10)]);
    expect(evaluateCastWithoutPrior(SECRET_TECH_NEEDS_DANCE, onEdge, thr(PAIR_WINDOW_S), 'warning')).toBeNull();
    expect(evaluateCastWithoutPrior(SECRET_TECH_NEEDS_DANCE, pastEdge, thr(PAIR_WINDOW_S), 'warning')).not.toBeNull();
  });

  it('evaluateRules names a violated rule by its description, matching how rulesFollowed names it', () => {
    const description = 'Secret Technique always inside Shadow Dance';
    const rule: RulebookRule = { severity: 'warning', description, condition: SECRET_TECH_NEEDS_DANCE };
    const violated = evaluateRules([benched(rule)], ruleCtx([cast(SECRET_TECHNIQUE, 10)]));
    expect(violated[0].label).toBe(description);
    expect(rulesFollowed([benched(rule)], ruleCtx([cast(SHADOW_DANCE, 8), cast(SECRET_TECHNIQUE, 10)]))).toEqual([description]);
  });

  it('evaluateRules falls back to the synthesized label when a rule has no description', () => {
    const rule: RulebookRule = { severity: 'warning', condition: SECRET_TECH_NEEDS_DANCE };
    expect(evaluateRules([benched(rule)], ruleCtx([cast(SECRET_TECHNIQUE, 10)]))[0].label)
      .toBe('Secret Technique without Shadow Dance');
  });

  it('evaluateRules carries the rule type onto the finding', () => {
    const rule: RulebookRule = { type: 'cooldown_pairing', severity: 'warning', condition: SECRET_TECH_NEEDS_DANCE };
    const findings = evaluateRules([benched(rule)], ruleCtx([cast(SECRET_TECHNIQUE, 10)]));
    expect(findings[0].rule_type).toBe('cooldown_pairing');
  });
});

describe('rule severity', () => {
  it.each(['critical', 'warning', 'info'] as RuleSeverity[])('carries an authored %s onto the finding', severity => {
    const rule: RulebookRule = { severity, condition: SECRET_TECH_NEEDS_DANCE };
    expect(evaluateRules([benched(rule)], ruleCtx([cast(SECRET_TECHNIQUE, 10)]))[0].severity).toBe(severity);
  });
});

describe('ruleLabel', () => {
  it('prefers the rule description when present', () => {
    expect(ruleLabel(SECRET_TECH_NEEDS_DANCE, 'Pair Shadow Dance with Secret Technique'))
      .toBe('Pair Shadow Dance with Secret Technique');
  });

  it('describes a paired-cast rule as "<spell> with <required>"', () => {
    expect(ruleLabel(SECRET_TECH_NEEDS_DANCE)).toBe('Secret Technique with Shadow Dance');
  });

  it('describes a hold rule as "<spells> held for <anchor>"', () => {
    expect(ruleLabel(HOLD_DANCE_FOR_BLADES)).toBe('Shadow Dance held for Shadow Blades');
  });
});

// Fight-relative seconds shared by the new-kind fixtures.
const DANCE_START_S = 20, DANCE_END_S = 28;
const COMBO_POINT_TYPE = 4;  // WCL power-type id for combo points
const MAX_COMBO_POINTS = 5;

describe('evaluateCastOutsideBuff', () => {
  const insideDance: CastOutsideBuffCondition = {
    kind: 'cast_outside_buff', spell_id: SECRET_TECHNIQUE, spell_name: 'Secret Technique',
    buff_spell_id: SHADOW_DANCE, buff_spell_name: 'Shadow Dance', require: 'inside',
  };
  const dance = buffWindow(SHADOW_DANCE, DANCE_START_S, DANCE_END_S);

  it('flags a cast made while the buff was down', () => {
    const ctx = ruleCtx([cast(SECRET_TECHNIQUE, DANCE_END_S + 5)], { buffs: dance });
    expect(evaluateCastOutsideBuff(insideDance, ctx, 'warning')?.measured?.value).toBe('1 / 1');
  });

  it('passes a cast made inside the buff span', () => {
    const ctx = ruleCtx([cast(SECRET_TECHNIQUE, DANCE_START_S + 2)], { buffs: dance });
    expect(evaluateCastOutsideBuff(insideDance, ctx, 'warning')).toBeNull();
  });

  it('inverts for require "outside", flagging the cast made while the buff was up', () => {
    const outsideDance: CastOutsideBuffCondition = { ...insideDance, require: 'outside' };
    const ctx = ruleCtx([cast(SECRET_TECHNIQUE, DANCE_START_S + 2)], { buffs: dance });
    expect(evaluateCastOutsideBuff(outsideDance, ctx, 'warning')?.measured?.value).toBe('1 / 1');
  });

  it('is not applicable when the judged spell was never cast', () => {
    expect(ruleApplicable(insideDance, ruleCtx([], { buffs: dance }))).toBe(false);
  });
});

describe('evaluateAuraUptimeBelow', () => {
  const RUPTURE_MIN_PCT = 90;  // what the top parses hold, supplied as a measured threshold
  const ruptureUptime: AuraUptimeBelowCondition = {
    kind: 'aura_uptime_below', aura_spell_id: RUPTURE, aura_spell_name: 'Rupture', on: 'target',
  };
  // The context fight runs 0..120s, so a 60s span is 50% uptime.
  const halfUptime = [applyDebuff(RUPTURE, 0), removeDebuff(RUPTURE, 60)];

  it('flags uptime under the authored threshold, measured against it', () => {
    const finding = evaluateAuraUptimeBelow(ruptureUptime, ruleCtx([], { debuffs: halfUptime }), thr(RUPTURE_MIN_PCT), 'warning');
    expect(finding?.measured).toEqual({ value: `50 / ${RUPTURE_MIN_PCT}`, unit: '% uptime' });
  });

  it('passes uptime at or above the threshold', () => {
    const nearFull = [applyDebuff(RUPTURE, 0), removeDebuff(RUPTURE, 115)];
    expect(evaluateAuraUptimeBelow(ruptureUptime, ruleCtx([], { debuffs: nearFull }), thr(RUPTURE_MIN_PCT), 'warning')).toBeNull();
  });

  it('stays silent on zero uptime, which reads as a build that skips the aura', () => {
    expect(evaluateAuraUptimeBelow(ruptureUptime, ruleCtx([]), thr(RUPTURE_MIN_PCT), 'warning')).toBeNull();
    expect(ruleApplicable(ruptureUptime, ruleCtx([]))).toBe(false);
  });

  it('reads the self stream when on is "self"', () => {
    const selfAura: AuraUptimeBelowCondition = { ...ruptureUptime, on: 'self' };
    const ctx = ruleCtx([], { buffs: [applyBuff(RUPTURE, 0), removeBuff(RUPTURE, 60)] });
    expect(evaluateAuraUptimeBelow(selfAura, ctx, thr(RUPTURE_MIN_PCT), 'warning')?.measured?.value).toBe(`50 / ${RUPTURE_MIN_PCT}`);
  });

  it('denominates on alive time, so the same 60s of dot reads as full uptime for a player who died at 60s', () => {
    const DEATH_S = 60;
    const ctx = ruleCtx([], { debuffs: halfUptime, deaths: [death(DEATH_S)] });
    expect(evaluateAuraUptimeBelow(ruptureUptime, ctx, thr(RUPTURE_MIN_PCT), 'warning')).toBeNull();
  });

  it('clamps the dot to alive time, so a dot outliving the player cannot read past 100%', () => {
    const ctx = ruleCtx([], { debuffs: [applyDebuff(RUPTURE, 0), removeDebuff(RUPTURE, 115)], deaths: [death(60)] });
    expect(measureRule(ruptureUptime, ctx)).toBe(100);
  });

  it('stays silent on a debuff applied before the pull, which arrives as a lone remove', () => {
    const ctx = ruleCtx([], { debuffs: [removeDebuff(RUPTURE, 20)] });
    expect(evaluateAuraUptimeBelow(ruptureUptime, ctx, thr(RUPTURE_MIN_PCT), 'warning')).toBeNull();
    expect(ruleApplicable(ruptureUptime, ctx)).toBe(false);
  });
});

describe('rule evaluator boundaries', () => {
  const dance = buffWindow(SHADOW_DANCE, DANCE_START_S, DANCE_END_S);

  // Measured on a real pull: 75 of 197 Hot Streak removals share the consuming cast's exact millisecond, so reading it as outside flags perfect play twice.
  it('reads a cast on the removal instant as inside the buff', () => {
    const insideDance: CastOutsideBuffCondition = {
      kind: 'cast_outside_buff', spell_id: SECRET_TECHNIQUE, spell_name: 'Secret Technique',
      buff_spell_id: SHADOW_DANCE, buff_spell_name: 'Shadow Dance', require: 'inside',
    };
    const ctx = ruleCtx([cast(SECRET_TECHNIQUE, DANCE_END_S)], { buffs: dance });
    expect(evaluateCastOutsideBuff(insideDance, ctx, 'warning')).toBeNull();
  });

  it('reads that same cast as having consumed the proc', () => {
    const spendDance: ProcWastedCondition = {
      kind: 'proc_wasted', buff_spell_id: SHADOW_DANCE, buff_spell_name: 'Shadow Dance',
      spend_spell_ids: [SECRET_TECHNIQUE], spend_spell_names: ['Secret Technique'],
    };
    const ctx = ruleCtx([cast(SECRET_TECHNIQUE, DANCE_END_S)], { buffs: dance });
    expect(evaluateProcWasted(spendDance, ctx, 'warning')).toBeNull();
  });

  it('passes uptime exactly at the measured bar (strict below)', () => {
    const HALF_UPTIME_PCT = 50;
    const exactly: AuraUptimeBelowCondition = {
      kind: 'aura_uptime_below', aura_spell_id: RUPTURE, aura_spell_name: 'Rupture', on: 'target',
    };
    const ctx = ruleCtx([], { debuffs: [applyDebuff(RUPTURE, 0), removeDebuff(RUPTURE, 60)] });
    expect(evaluateAuraUptimeBelow(exactly, ctx, thr(HALF_UPTIME_PCT), 'warning')).toBeNull();
  });

  it('accepts an opener step landing exactly on window_s', () => {
    const OPENER_WINDOW_S = 12;
    const opener: OpeningSequenceCondition = {
      kind: 'opening_sequence', spell_ids: [SHADOW_BLADES, SECRET_TECHNIQUE],
      spell_names: ['Shadow Blades', 'Secret Technique'],
    };
    const ctx = ruleCtx([cast(SHADOW_BLADES, 0), cast(SECRET_TECHNIQUE, OPENER_WINDOW_S)]);
    expect(evaluateOpeningSequence(opener, ctx, thr(OPENER_WINDOW_S), 'warning')).toBeNull();
  });
});

describe('evaluateOpeningSequence', () => {
  const OPENER_WINDOW_S = 12;
  const opener: OpeningSequenceCondition = {
    kind: 'opening_sequence',
    spell_ids: [SHADOW_BLADES, SHADOW_DANCE, SECRET_TECHNIQUE],
    spell_names: ['Shadow Blades', 'Shadow Dance', 'Secret Technique'],
  };

  it('passes the sequence cast in order inside the window', () => {
    const ctx = ruleCtx([cast(SHADOW_BLADES, 1), cast(SHADOW_DANCE, 3), cast(SECRET_TECHNIQUE, 5)]);
    expect(evaluateOpeningSequence(opener, ctx, thr(OPENER_WINDOW_S), 'warning')).toBeNull();
  });

  it('flags a sequence cast out of order, reporting the steps reached', () => {
    const ctx = ruleCtx([cast(SHADOW_BLADES, 1), cast(SECRET_TECHNIQUE, 3), cast(SHADOW_DANCE, 5)]);
    expect(evaluateOpeningSequence(opener, ctx, thr(OPENER_WINDOW_S), 'warning')?.measured).toEqual({ value: '2 / 3', unit: 'step(s)' });
  });

  it('flags a step that lands past the opener window', () => {
    const ctx = ruleCtx([cast(SHADOW_BLADES, 1), cast(SHADOW_DANCE, 3), cast(SECRET_TECHNIQUE, OPENER_WINDOW_S + 5)]);
    expect(evaluateOpeningSequence(opener, ctx, thr(OPENER_WINDOW_S), 'warning')?.measured?.value).toBe('2 / 3');
  });

  it('tolerates unrelated casts between the steps', () => {
    const ctx = ruleCtx([cast(SHADOW_BLADES, 1), cast(EVISCERATE, 2), cast(SHADOW_DANCE, 3), cast(SECRET_TECHNIQUE, 5)]);
    expect(evaluateOpeningSequence(opener, ctx, thr(OPENER_WINDOW_S), 'warning')).toBeNull();
  });

  it('is judged on neither side of a pull with none of the sequence spells', () => {
    const ctx = ruleCtx([cast(EVISCERATE, 1)]);
    const rule: RulebookRule = { severity: 'warning', condition: opener };
    expect(ruleApplicable(opener, ctx)).toBe(false);
    expect(evaluateRules([benched(rule, thr(OPENER_WINDOW_S))], ctx)).toEqual([]);
    expect(rulesFollowed([benched(rule, thr(OPENER_WINDOW_S))], ctx)).toEqual([]);
  });

  it('still flags a first step landing past the window, which is why the gate reads casts and not progress', () => {
    const ctx = ruleCtx([cast(EVISCERATE, 1), cast(SHADOW_BLADES, 30)]);
    const rule: RulebookRule = { severity: 'warning', condition: opener };
    expect(evaluateRules([benched(rule, thr(OPENER_WINDOW_S))], ctx)[0].measured?.value).toBe('0 / 3');
  });
});

describe('evaluateCastAtTargetCount', () => {
  const MIN_AOE_TARGETS = 3;
  const TARGET_FLOOR = MIN_AOE_TARGETS;  // the count the field uses it at, measured
  const CAST_S = 10;
  const blackPowder: CastAtTargetCountCondition = {
    kind: 'cast_at_target_count', spell_id: BLACK_POWDER, spell_name: 'Black Powder', bound: 'min',
  };
  const hits = (targets: number[]) => targets.map(id => damage(BLACK_POWDER, CAST_S + 1, 100, { target: id }));

  it('flags an AoE finisher pressed under the target floor', () => {
    const ctx = ruleCtx([cast(BLACK_POWDER, CAST_S)], { damage: hits([1, 2]) });
    expect(evaluateCastAtTargetCount(blackPowder, ctx, thr(TARGET_FLOOR), 'warning')?.measured?.value).toBe('1 / 1');
  });

  it('passes the same cast once enough enemies are hit', () => {
    const ctx = ruleCtx([cast(BLACK_POWDER, CAST_S)], { damage: hits([1, 2, 3]) });
    expect(evaluateCastAtTargetCount(blackPowder, ctx, thr(TARGET_FLOOR), 'warning')).toBeNull();
  });

  it('flags a single-target ability pressed over its ceiling', () => {
    const FIELD_CEILING = 2;  // the field stops using it above this, measured
    const capped: CastAtTargetCountCondition = {
      kind: 'cast_at_target_count', spell_id: EVISCERATE, spell_name: 'Eviscerate', bound: 'max',
    };
    const ctx = ruleCtx([cast(EVISCERATE, CAST_S)],
      { damage: [1, 2, 3].map(id => damage(EVISCERATE, CAST_S + 1, 100, { target: id })) });
    expect(evaluateCastAtTargetCount(capped, ctx, thr(FIELD_CEILING), 'warning')?.measured?.value).toBe('1 / 1');
  });

  it('counts copies of one add separately, since they share a targetID and differ only by instance', () => {
    const ADD_ID = 7;
    const copies = [1, 2, 3].map(instance =>
      ({ ...damage(BLACK_POWDER, CAST_S + 1, 100, { target: ADD_ID }), targetInstance: instance }));
    const ctx = ruleCtx([cast(BLACK_POWDER, CAST_S)], { damage: copies });
    expect(evaluateCastAtTargetCount(blackPowder, ctx, thr(TARGET_FLOOR), 'warning')).toBeNull();
  });

  it('ignores a cast with no damage recorded near it, rather than reading it as zero targets', () => {
    const ctx = ruleCtx([cast(BLACK_POWDER, CAST_S)], { damage: hits([1, 2]).map(e => ({ ...e, timestamp: 90_000 })) });
    expect(evaluateCastAtTargetCount(blackPowder, ctx, thr(TARGET_FLOOR), 'warning')).toBeNull();
  });

  it('counts enemies reached by any ability, since the bound asks how many were up rather than how many this cast struck', () => {
    const FIELD_CEILING = 2;
    const capped: CastAtTargetCountCondition = {
      kind: 'cast_at_target_count', spell_id: EVISCERATE, spell_name: 'Eviscerate', bound: 'max',
    };
    const ctx = ruleCtx([cast(EVISCERATE, CAST_S)], {
      damage: [
        damage(EVISCERATE, CAST_S + 1, 100, { target: 1 }),
        ...[1, 2, 3].map(id => damage(RUPTURE, CAST_S + 1, 50, { target: id })),
      ],
    });
    expect(evaluateCastAtTargetCount(capped, ctx, thr(FIELD_CEILING), 'warning')?.measured?.value).toBe('1 / 1');
  });

  it('rounds a sub-target band away, so a field that agrees on 3 still flags a cast at 2', () => {
    const SUB_TARGET_BAND = 0.3;
    const ctx = ruleCtx([cast(BLACK_POWDER, CAST_S)], { damage: hits([1, 2]) });
    expect(evaluateCastAtTargetCount(blackPowder, ctx, thr(TARGET_FLOOR, SUB_TARGET_BAND), 'warning')?.measured?.value).toBe('1 / 1');
  });
});

describe('evaluateResourceAtCast', () => {
  const RESOURCE_FLOOR = 1;  // the field spends at a full pool, measured as a share of cap
  const finisherAtMax: ResourceAtCastCondition = {
    kind: 'resource_at_cast', spell_id: EVISCERATE, spell_name: 'Eviscerate',
    resource_type: COMBO_POINT_TYPE, resource_name: 'combo points', bound: 'min',
  };
  const atCombo = (atS: number, amount: number) =>
    cast(EVISCERATE, atS, { resources: [{ amount, max: MAX_COMBO_POINTS, type: COMBO_POINT_TYPE }] });

  it('flags a finisher spent below the authored threshold', () => {
    const ctx = ruleCtx([atCombo(10, 3), atCombo(20, MAX_COMBO_POINTS)]);
    expect(evaluateResourceAtCast(finisherAtMax, ctx, thr(RESOURCE_FLOOR), 'warning')?.measured).toEqual({ value: '1 / 2', unit: 'cast(s)' });
  });

  it('passes finishers spent at the threshold', () => {
    expect(evaluateResourceAtCast(finisherAtMax, ruleCtx([atCombo(10, MAX_COMBO_POINTS)]), thr(RESOURCE_FLOOR), 'warning')).toBeNull();
  });

  it('flags a generator pressed above its ceiling', () => {
    const FIELD_CEILING_FRAC = 0.8;  // the field generates below four fifths of the cap, measured
    const noOvercap: ResourceAtCastCondition = {
      kind: 'resource_at_cast', spell_id: BLACK_POWDER, spell_name: 'Black Powder',
      resource_type: COMBO_POINT_TYPE, resource_name: 'combo points', bound: 'max',
    };
    const ctx = ruleCtx([cast(BLACK_POWDER, 10,
      { resources: [{ amount: MAX_COMBO_POINTS, max: MAX_COMBO_POINTS, type: COMBO_POINT_TYPE }] })]);
    expect(evaluateResourceAtCast(noOvercap, ctx, thr(FIELD_CEILING_FRAC), 'warning')?.measured?.value).toBe('1 / 1');
  });

  it('is not applicable when the casts carry no resource snapshot', () => {
    expect(evaluateResourceAtCast(finisherAtMax, ruleCtx([cast(EVISCERATE, 10)]), thr(RESOURCE_FLOOR), 'warning')).toBeNull();
    expect(ruleApplicable(finisherAtMax, ruleCtx([cast(EVISCERATE, 10)]))).toBe(false);
  });

  it('ignores a pool the event flattened from the target rather than the caster', () => {
    const RESOURCE_ACTOR_TARGET = 2;
    const ctx = ruleCtx([{ ...atCombo(10, 1), resourceActor: RESOURCE_ACTOR_TARGET }]);
    expect(evaluateResourceAtCast(finisherAtMax, ctx, thr(RESOURCE_FLOOR), 'warning')).toBeNull();
    expect(ruleApplicable(finisherAtMax, ctx)).toBe(false);
  });
});

describe('evaluateProcWasted', () => {
  const spendDance: ProcWastedCondition = {
    kind: 'proc_wasted', buff_spell_id: SHADOW_DANCE, buff_spell_name: 'Shadow Dance',
    spend_spell_ids: [SECRET_TECHNIQUE], spend_spell_names: ['Secret Technique'],
  };
  const dance = buffWindow(SHADOW_DANCE, DANCE_START_S, DANCE_END_S);

  it('flags a proc that expired with nothing spent into it', () => {
    const ctx = ruleCtx([cast(SECRET_TECHNIQUE, DANCE_END_S + 5)], { buffs: dance });
    expect(evaluateProcWasted(spendDance, ctx, 'warning')?.measured).toEqual({ value: '1 / 1', unit: 'proc(s)' });
  });

  it('passes a proc consumed inside its span', () => {
    const ctx = ruleCtx([cast(SECRET_TECHNIQUE, DANCE_START_S + 2)], { buffs: dance });
    expect(evaluateProcWasted(spendDance, ctx, 'warning')).toBeNull();
  });

  it('ignores a span still open at the end of the pull', () => {
    const ctx = ruleCtx([], { buffs: [applyBuff(SHADOW_DANCE, DANCE_START_S)] });
    expect(evaluateProcWasted(spendDance, ctx, 'warning')).toBeNull();
    expect(ruleApplicable(spendDance, ctx)).toBe(false);
  });

  it('ignores a span the log closes on the pull ending, which the kill took rather than the player wasting', () => {
    const ctx = ruleCtx([], { buffs: buffWindow(SHADOW_DANCE, 100, RULE_FIGHT_END_MS / 1000) });
    expect(evaluateProcWasted(spendDance, ctx, 'warning')).toBeNull();
    expect(ruleApplicable(spendDance, ctx)).toBe(false);
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
    // Shadow Blades at 10 and 120; the held Shadow Dance at 50 is outside [105,120).
    expect(rulesFollowed([benched(holdDanceForBlades, thr(HOLD_WINDOW_S))], ruleCtx([cast(SHADOW_BLADES, 10), cast(SHADOW_BLADES, 120), cast(SHADOW_DANCE, 50)])))
      .toEqual(['Hold Shadow Dance for Shadow Blades']);
  });

  it('omits the rule when Shadow Dance is spent in the hold window before Shadow Blades', () => {
    expect(rulesFollowed([benched(holdDanceForBlades, thr(HOLD_WINDOW_S))], ruleCtx([cast(SHADOW_BLADES, 10), cast(SHADOW_BLADES, 120), cast(SHADOW_DANCE, 110)]))).toEqual([]);
  });

  it('omits the rule when the held cooldown was never cast', () => {
    expect(rulesFollowed([benched(holdDanceForBlades, thr(HOLD_WINDOW_S))], ruleCtx([cast(SHADOW_BLADES, 10), cast(SHADOW_BLADES, 120)]))).toEqual([]);
  });

  it('omits the rule with only a single Shadow Blades cast', () => {
    expect(rulesFollowed([benched(holdDanceForBlades, thr(HOLD_WINDOW_S))], ruleCtx([cast(SHADOW_BLADES, 10), cast(SHADOW_DANCE, 5)]))).toEqual([]);
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

describe('measureRule', () => {
  it('measures the widest lead a paired cast needed, so the window covers how loosely the field pairs', () => {
    const TIGHT_LEAD_S = 2, LOOSE_LEAD_S = 6;
    const ctx = ruleCtx([
      cast(SHADOW_DANCE, 10), cast(SECRET_TECHNIQUE, 10 + TIGHT_LEAD_S),
      cast(SHADOW_DANCE, 40), cast(SECRET_TECHNIQUE, 40 + LOOSE_LEAD_S),
    ]);
    expect(measureRule(SECRET_TECH_NEEDS_DANCE, ctx)).toBe(LOOSE_LEAD_S);
  });

  it('measures nothing from a pull where the cast never paired at all', () => {
    expect(measureRule(SECRET_TECH_NEEDS_DANCE, ruleCtx([cast(SECRET_TECHNIQUE, 10)]))).toBeNull();
  });

  it('measures the gap a hold rule keeps clear before a non-opener anchor', () => {
    const CLEAR_GAP_S = 30;
    const ctx = ruleCtx([
      cast(SHADOW_BLADES, 10), cast(SHADOW_DANCE, 90), cast(SHADOW_BLADES, 90 + CLEAR_GAP_S),
    ]);
    expect(measureRule(HOLD_DANCE_FOR_BLADES, ctx)).toBe(CLEAR_GAP_S);
  });

  it('measures the uptime the pull held for an aura rule', () => {
    const uptime: AuraUptimeBelowCondition = {
      kind: 'aura_uptime_below', aura_spell_id: RUPTURE, aura_spell_name: 'Rupture', on: 'target',
    };
    const ctx = ruleCtx([], { debuffs: [applyDebuff(RUPTURE, 0), removeDebuff(RUPTURE, 60)] });
    expect(measureRule(uptime, ctx)).toBe(50);
  });

  it('measures nothing for the kinds that need no magnitude', () => {
    const proc: ProcWastedCondition = {
      kind: 'proc_wasted', buff_spell_id: SHADOW_DANCE, buff_spell_name: 'Shadow Dance',
      spend_spell_ids: [SECRET_TECHNIQUE], spend_spell_names: ['Secret Technique'],
    };
    expect(measureRule(proc, ruleCtx([], { buffs: buffWindow(SHADOW_DANCE, 10, 20) }))).toBeNull();
  });
});

// Every other fixture runs a zero band; these pin which side of the measured value each kind forgives.
describe('threshold band', () => {
  it('widens the pairing window, accepting a lead the bare median would flag', () => {
    const BAND_S = 3;
    const ctx = ruleCtx([cast(SHADOW_DANCE, 0), cast(SECRET_TECHNIQUE, PAIR_WINDOW_S + 2)]);
    expect(evaluateCastWithoutPrior(SECRET_TECH_NEEDS_DANCE, ctx, thr(PAIR_WINDOW_S, BAND_S), 'warning')).toBeNull();
    expect(evaluateCastWithoutPrior(SECRET_TECH_NEEDS_DANCE, ctx, thr(PAIR_WINDOW_S), 'warning')).not.toBeNull();
  });

  it('narrows the hold window, accepting a charge spent just outside it', () => {
    const BAND_S = 5;
    const ctx = ruleCtx([cast(SHADOW_BLADES, 10), cast(SHADOW_BLADES, 120), cast(SHADOW_DANCE, 108)]);
    expect(evaluateHoldForAnchor(HOLD_DANCE_FOR_BLADES, ctx, thr(HOLD_WINDOW_S, BAND_S), 'critical')).toBeNull();
    expect(evaluateHoldForAnchor(HOLD_DANCE_FOR_BLADES, ctx, thr(HOLD_WINDOW_S), 'critical')).not.toBeNull();
  });

  it('lowers the uptime bar', () => {
    const UPTIME_PCT = 90, BAND_PCT = 45;
    const uptime: AuraUptimeBelowCondition = {
      kind: 'aura_uptime_below', aura_spell_id: RUPTURE, aura_spell_name: 'Rupture', on: 'target',
    };
    const ctx = ruleCtx([], { debuffs: [applyDebuff(RUPTURE, 0), removeDebuff(RUPTURE, 60)] });
    expect(evaluateAuraUptimeBelow(uptime, ctx, thr(UPTIME_PCT, BAND_PCT), 'warning')).toBeNull();
    expect(evaluateAuraUptimeBelow(uptime, ctx, thr(UPTIME_PCT), 'warning')).not.toBeNull();
  });

  it('lengthens the opener window', () => {
    const OPENER_WINDOW_S = 12, BAND_S = 5, LATE_STEP_S = 15;
    const opener: OpeningSequenceCondition = {
      kind: 'opening_sequence', spell_ids: [SHADOW_BLADES, SECRET_TECHNIQUE],
      spell_names: ['Shadow Blades', 'Secret Technique'],
    };
    const ctx = ruleCtx([cast(SHADOW_BLADES, 0), cast(SECRET_TECHNIQUE, LATE_STEP_S)]);
    expect(evaluateOpeningSequence(opener, ctx, thr(OPENER_WINDOW_S, BAND_S), 'warning')).toBeNull();
    expect(evaluateOpeningSequence(opener, ctx, thr(OPENER_WINDOW_S), 'warning')).not.toBeNull();
  });

  it('drops the target floor by a whole target once the field spread reaches one', () => {
    const TARGET_FLOOR = 3, BAND_TARGETS = 1.2;
    const blackPowder: CastAtTargetCountCondition = {
      kind: 'cast_at_target_count', spell_id: BLACK_POWDER, spell_name: 'Black Powder', bound: 'min',
    };
    const ctx = ruleCtx([cast(BLACK_POWDER, 10)],
      { damage: [1, 2].map(id => damage(BLACK_POWDER, 11, 100, { target: id })) });
    expect(evaluateCastAtTargetCount(blackPowder, ctx, thr(TARGET_FLOOR, BAND_TARGETS), 'warning')).toBeNull();
    expect(evaluateCastAtTargetCount(blackPowder, ctx, thr(TARGET_FLOOR), 'warning')).not.toBeNull();
  });

  it('lowers the resource floor', () => {
    const POOL_FLOOR_FRAC = 1, BAND_FRAC = 0.5, SPENT_POINTS = 3;
    const finisher: ResourceAtCastCondition = {
      kind: 'resource_at_cast', spell_id: EVISCERATE, spell_name: 'Eviscerate',
      resource_type: COMBO_POINT_TYPE, resource_name: 'combo points', bound: 'min',
    };
    const ctx = ruleCtx([cast(EVISCERATE, 10,
      { resources: [{ amount: SPENT_POINTS, max: MAX_COMBO_POINTS, type: COMBO_POINT_TYPE }] })]);
    expect(evaluateResourceAtCast(finisher, ctx, thr(POOL_FLOOR_FRAC, BAND_FRAC), 'warning')).toBeNull();
    expect(evaluateResourceAtCast(finisher, ctx, thr(POOL_FLOOR_FRAC), 'warning')).not.toBeNull();
  });
});

describe('ruleThreshold', () => {
  const PARSES = 4;

  it('takes the median of what the parses measured and their deviation as the band', () => {
    const SPREAD_DEVIATION = 0.8165;
    const { threshold, sample_count } = ruleThreshold([4, 5, 6, 5], PARSES);
    expect(sample_count).toBe(PARSES);
    expect(threshold?.value).toBe(5);
    expect(threshold?.band).toBeCloseTo(SPREAD_DEVIATION, 4);
  });

  it('floors the band at a tenth of the median, so a field that agrees exactly still tolerates jitter', () => {
    expect(ruleThreshold([5, 5, 5, 5], PARSES).threshold).toEqual({ value: 5, band: 0.5 });
  });

  it('accepts exactly half the parses supplying a magnitude', () => {
    const PAIR_DEVIATION = 0.7071;
    const { threshold, sample_count } = ruleThreshold([5, 6, null, null], PARSES);
    expect(sample_count).toBe(2);
    expect(threshold?.value).toBe(5.5);
    expect(threshold?.band).toBeCloseTo(PAIR_DEVIATION, 4);
  });

  it('refuses a threshold when fewer than half the parses could supply one', () => {
    expect(ruleThreshold([5, null, null, null], PARSES).threshold).toBeNull();
  });

  it('refuses a threshold when no parse could supply one', () => {
    expect(ruleThreshold([null, null], 2)).toEqual({ threshold: null, sample_count: 0 });
  });
});

describe('benchedRules', () => {
  const needsMagnitude: RulebookRule = { severity: 'warning', description: 'pair', condition: SECRET_TECH_NEEDS_DANCE };
  const needsNone: RulebookRule = {
    severity: 'warning', description: 'proc',
    condition: {
      kind: 'proc_wasted', buff_spell_id: SHADOW_DANCE, buff_spell_name: 'Shadow Dance',
      spend_spell_ids: [SECRET_TECHNIQUE], spend_spell_names: ['Secret Technique'],
    },
  };

  it('keeps a rule whose magnitude this encounter measured', () => {
    expect(benchedRules([benched(needsMagnitude)]).map(entry => entry.rule)).toEqual([needsMagnitude]);
  });

  it('drops a rule whose magnitude the encounter could not measure, rather than inventing one', () => {
    expect(benchedRules([benched(needsMagnitude, null)])).toEqual([]);
  });

  it('keeps a rule that needs no magnitude, whatever the encounter measured', () => {
    expect(benchedRules([benched(needsNone, null)]).map(entry => entry.rule)).toEqual([needsNone]);
  });

  it('drops a rule with no condition before a magnitude is even considered', () => {
    const unconformed = { rule: { description: 'none' }, threshold: null, sample_count: 0 } as unknown as BenchedRule;
    expect(benchedRules([unconformed])).toEqual([]);
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
    { name: 'an on-self uptime rule still reads deaths, which bound its denominator', rules: [uptime('self')], stream: 'deaths', needed: true },
    { name: 'a target-count rule reads damage', rules: [targetCount], stream: 'damage', needed: true },
    { name: 'a target-count rule leaves deaths unfetched', rules: [targetCount], stream: 'deaths', needed: false },
    { name: 'a rulebook with no rules leaves damage unfetched', rules: [], stream: 'damage', needed: false },
    { name: 'a rulebook with no rules leaves enemy auras unfetched', rules: [], stream: 'enemyAuras', needed: false },
    { name: 'a rulebook with no rules leaves deaths unfetched', rules: [], stream: 'deaths', needed: false },
  ];

  it.each(cases)('$name', ({ rules, stream, needed }) => {
    expect(rulesNeed(rules, stream)).toBe(needed);
  });
});
