import { describe, it, expect } from 'vitest';
import {
  RulebookRule, RuleSeverity,
  CastWithoutPriorCondition, HoldCooldownForAnchorCondition, CastOutsideBuffCondition,
  AuraUptimeBelowCondition, OpeningSequenceCondition,
  CastAtTargetCountCondition, ResourceAtCastCondition, ProcWastedCondition, FillerInBuffCondition,
  SpendAtStacksCondition, AuraClippedCondition, FillerBelowHealthCondition,
} from '../../../core/models/rulebook.models';
import { WclEvent } from '../../../core/models/wcl.models';
import {
  SHADOW_BLADES, SHADOW_DANCE, SECRET_TECHNIQUE, RUPTURE, EVISCERATE, BLACK_POWDER,
  WRATH, STARFIRE, ECLIPSE_SOLAR, LIGHTNING_BOLT, MAELSTROM_WEAPON, MOONFIRE, MOONFIRE_DOT, EXECUTE, SLAM,
  SHADOW_BLADES_DAMAGE,
} from '../../../../testing/spell-ids';
import {
  cast, applyBuff, removeBuff, buffWindow, applyDebuff, removeDebuff, refreshDebuff, applyBuffStack, damage,
} from '../../../../testing/builders/events';
import {
  BenchedRule, RuleContext, RuleStream, RuleBand,
  buildRuleContext, evaluateRules, rulesFollowed, ruleLabel, ruleApplicable,
  rulesNeed, judgeableRules, benchedRules, sampleRule, ruleBand,
  ruleJudging, RuleJudging, RuleSample, Severity,
  evaluateCastWithoutPrior as rawCastWithoutPrior,
  evaluateHoldForAnchor as rawHoldForAnchor,
  evaluateCastOutsideBuff as rawCastOutsideBuff,
  evaluateAuraUptimeBelow as rawAuraUptimeBelow,
  evaluateOpeningSequence as rawOpeningSequence,
  evaluateCastAtTargetCount as rawCastAtTargetCount,
  evaluateResourceAtCast as rawResourceAtCast,
  evaluateProcWasted as rawProcWasted,
  evaluateFillerInBuff as rawFillerInBuff,
  evaluateSpendAtStacks as rawSpendAtStacks,
  evaluateAuraClipped as rawAuraClipped,
  evaluateFillerBelowHealth as rawFillerBelowHealth,
} from './rotation-rules';
import { RuleCondition } from '../../../core/models/rulebook.models';
import { AnalysisFinding } from '../../../core/models/analysis.models';

/** Each evaluator is called with the judging its own kind declares, so a spec can never assert against a side the table does not use. */
function judged<C extends RuleCondition>(
  evaluate: (c: C, ctx: RuleContext, band: RuleBand, judging: RuleJudging, severity: Severity, remedy?: string) => AnalysisFinding | null,
) {
  return (c: C, ctx: RuleContext, band: RuleBand, severity: Severity, remedy?: string) =>
    evaluate(c, ctx, band, ruleJudging(c), severity, remedy);
}
const evaluateCastWithoutPrior = judged(rawCastWithoutPrior);
const evaluateHoldForAnchor = judged(rawHoldForAnchor);
const evaluateCastOutsideBuff = judged(rawCastOutsideBuff);
const evaluateAuraUptimeBelow = judged(rawAuraUptimeBelow);
const evaluateOpeningSequence = judged(rawOpeningSequence);
const evaluateCastAtTargetCount = judged(rawCastAtTargetCount);
const evaluateResourceAtCast = judged(rawResourceAtCast);
const evaluateProcWasted = judged(rawProcWasted);
const evaluateFillerInBuff = judged(rawFillerInBuff);
const evaluateSpendAtStacks = judged(rawSpendAtStacks);
const evaluateAuraClipped = judged(rawAuraClipped);
const evaluateFillerBelowHealth = judged(rawFillerBelowHealth);
import { withRelativeS } from '../../../shared/analysis/wcl-projections';

// Zero tolerance keeps the fixture arithmetic exact; hi defaults to lo for the one-sided kinds this factory feeds most often.
const PAIR_WINDOW_S = 5, HOLD_WINDOW_S = 15;
function band(lo: number, hi = lo, tolerance = 0): RuleBand {
  return { lo, hi, tolerance };
}

// The share kinds judge a violation share against [lo, hi]; a field that never breaks the rule flags any nonzero share.
const FIELD_NEVER = band(0);

// A rule whose band this encounter measured, so fixtures about something else are not gated on it.
function benched(rule: RulebookRule, ruleBandValue: RuleBand | null = band(PAIR_WINDOW_S)): BenchedRule {
  return { rule, band: ruleBandValue, sample_count: ruleBandValue == null ? 0 : 10 };
}

// Build a RuleContext for a 0..120s fight from just the casts - keeps the rule call sites terse.
const RULE_FIGHT_END_S = 120;
interface RuleCtxOverrides { buffs: WclEvent[]; debuffs: WclEvent[]; damage: WclEvent[]; fightDurationS: number }
function ruleCtx(casts: WclEvent[], over: Partial<RuleCtxOverrides> = {}): RuleContext {
  return buildRuleContext({
    casts: withRelativeS(casts, 0),
    buffs: withRelativeS(over.buffs ?? [], 0),
    debuffs: withRelativeS(over.debuffs ?? [], 0),
    damage: withRelativeS(over.damage ?? [], 0),
    fightDurationS: over.fightDurationS ?? RULE_FIGHT_END_S,
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
    const ctx = ruleCtx([cast(SHADOW_DANCE, 10), cast(SECRET_TECHNIQUE, 30)]);
    const finding = evaluateCastWithoutPrior(SECRET_TECH_NEEDS_DANCE, ctx, band(PAIR_WINDOW_S), 'warning', 'do x');
    expect(finding).not.toBeNull();
    expect(finding!.measured).toEqual({ value: '1 / 1', unit: 'cast(s)' });
    expect(finding!.details?.remedy).toBe('do x');
  });

  it('passes when Shadow Dance precedes Secret Technique inside the window', () => {
    const ctx = ruleCtx([cast(SHADOW_DANCE, 10), cast(SECRET_TECHNIQUE, 12)]);
    expect(evaluateCastWithoutPrior(SECRET_TECH_NEEDS_DANCE, ctx, band(PAIR_WINDOW_S), 'warning')).toBeNull();
  });

  it('flags Shadow Dance spent in the hold window before Shadow Blades', () => {
    // Shadow Blades at 10 and 120; the second (120) is the one evaluated; Shadow Dance at 110 is within 15s.
    const ctx = ruleCtx([cast(SHADOW_BLADES, 10), cast(SHADOW_BLADES, 120), cast(SHADOW_DANCE, 110)]);
    const finding = evaluateHoldForAnchor(HOLD_DANCE_FOR_BLADES, ctx, band(HOLD_WINDOW_S), 'critical');
    expect(finding).not.toBeNull();
    expect(finding!.measured).toEqual({ value: '1 / 1', unit: 'charge(s)' });
  });

  it('flags a required cast that only follows the judged one, because position defaults to before', () => {
    const ctx = ruleCtx([cast(SECRET_TECHNIQUE, 10), cast(SHADOW_DANCE, 12)]);
    expect(evaluateCastWithoutPrior(SECRET_TECH_NEEDS_DANCE, ctx, band(PAIR_WINDOW_S), 'warning')).not.toBeNull();
  });

  it('accepts a required cast on either side when position is either', () => {
    const paired: CastWithoutPriorCondition = { ...SECRET_TECH_NEEDS_DANCE, position: 'either' };
    const danceAfter = ruleCtx([cast(SECRET_TECHNIQUE, 10), cast(SHADOW_DANCE, 12)]);
    const danceBefore = ruleCtx([cast(SHADOW_DANCE, 8), cast(SECRET_TECHNIQUE, 10)]);
    expect(evaluateCastWithoutPrior(paired, danceAfter, band(PAIR_WINDOW_S), 'warning')).toBeNull();
    expect(evaluateCastWithoutPrior(paired, danceBefore, band(PAIR_WINDOW_S), 'warning')).toBeNull();
  });

  it('requires the companion to follow when position is after', () => {
    const followUp: CastWithoutPriorCondition = { ...SECRET_TECH_NEEDS_DANCE, position: 'after' };
    const danceAfter = ruleCtx([cast(SECRET_TECHNIQUE, 10), cast(SHADOW_DANCE, 12)]);
    const danceBefore = ruleCtx([cast(SHADOW_DANCE, 8), cast(SECRET_TECHNIQUE, 10)]);
    expect(evaluateCastWithoutPrior(followUp, danceAfter, band(PAIR_WINDOW_S), 'warning')).toBeNull();
    expect(evaluateCastWithoutPrior(followUp, danceBefore, band(PAIR_WINDOW_S), 'warning')).not.toBeNull();
  });

  it('accepts a companion exactly on the window edge but not past it', () => {
    // hi is 5, so a Shadow Dance at 5 covers a Secret Technique at 10 and one at 4.9 does not.
    const onEdge = ruleCtx([cast(SHADOW_DANCE, 5), cast(SECRET_TECHNIQUE, 10)]);
    const pastEdge = ruleCtx([cast(SHADOW_DANCE, 4.9), cast(SECRET_TECHNIQUE, 10)]);
    expect(evaluateCastWithoutPrior(SECRET_TECH_NEEDS_DANCE, onEdge, band(PAIR_WINDOW_S), 'warning')).toBeNull();
    expect(evaluateCastWithoutPrior(SECRET_TECH_NEEDS_DANCE, pastEdge, band(PAIR_WINDOW_S), 'warning')).not.toBeNull();
  });

  it('accepts a charge spent exactly at the hold floor but not one a second inside it', () => {
    // Shadow Blades anchors at 10 and 130; lo is 15, so a gap of exactly 15 passes and 14 does not.
    const onFloor = ruleCtx([cast(SHADOW_BLADES, 10), cast(SHADOW_BLADES, 130), cast(SHADOW_DANCE, 115)]);
    const pastFloor = ruleCtx([cast(SHADOW_BLADES, 10), cast(SHADOW_BLADES, 130), cast(SHADOW_DANCE, 116)]);
    expect(evaluateHoldForAnchor(HOLD_DANCE_FOR_BLADES, onFloor, band(HOLD_WINDOW_S), 'critical')).toBeNull();
    expect(evaluateHoldForAnchor(HOLD_DANCE_FOR_BLADES, pastFloor, band(HOLD_WINDOW_S), 'critical')).not.toBeNull();
  });

  it('leaves a charge spent far earlier than the field alone, since a long gap is a prompt spend rather than a hold', () => {
    const FIELD_LO = 10, FIELD_HI = 40;
    const spentEarly = ruleCtx([cast(SHADOW_BLADES, 10), cast(SHADOW_BLADES, 200), cast(SHADOW_DANCE, 50)]);
    const atLo = ruleCtx([cast(SHADOW_BLADES, 10), cast(SHADOW_BLADES, 200), cast(SHADOW_DANCE, 20)]);
    expect(evaluateHoldForAnchor(HOLD_DANCE_FOR_BLADES, spentEarly, band(FIELD_LO, FIELD_HI), 'critical', 'do x')).toBeNull();
    // Exactly on the floor is inside the field's window; only under it is a hold.
    expect(evaluateHoldForAnchor(HOLD_DANCE_FOR_BLADES, atLo, band(FIELD_LO, FIELD_HI), 'critical', 'do x')).toBeNull();
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
    expect(evaluateCastOutsideBuff(insideDance, ctx, FIELD_NEVER, 'warning')?.measured?.value).toBe('1 / 1');
  });

  it('passes a cast made inside the buff span', () => {
    const ctx = ruleCtx([cast(SECRET_TECHNIQUE, DANCE_START_S + 2)], { buffs: dance });
    expect(evaluateCastOutsideBuff(insideDance, ctx, FIELD_NEVER, 'warning')).toBeNull();
  });

  it('inverts for require "outside", flagging the cast made while the buff was up', () => {
    const outsideDance: CastOutsideBuffCondition = { ...insideDance, require: 'outside' };
    const ctx = ruleCtx([cast(SECRET_TECHNIQUE, DANCE_START_S + 2)], { buffs: dance });
    expect(evaluateCastOutsideBuff(outsideDance, ctx, FIELD_NEVER, 'warning')?.measured?.value).toBe('1 / 1');
  });

  it('is not applicable when the judged spell was never cast', () => {
    expect(ruleApplicable(insideDance, ruleCtx([], { buffs: dance }))).toBe(false);
  });

  it('reads an opener cast inside a buff pre-cast before the pull as inside it', () => {
    const OPENER_S = 2;  // well before DANCE_END_S, inside the back-filled pre-pull window
    const preCastDance = [removeBuff(SHADOW_DANCE, DANCE_END_S)];
    const ctx = ruleCtx([cast(SECRET_TECHNIQUE, OPENER_S)], { buffs: preCastDance });
    expect(evaluateCastOutsideBuff(insideDance, ctx, FIELD_NEVER, 'warning')).toBeNull();
  });

  it('still flags a cast made after that pre-cast buff has already fallen', () => {
    const preCastDance = [removeBuff(SHADOW_DANCE, DANCE_END_S)];
    const ctx = ruleCtx([cast(SECRET_TECHNIQUE, DANCE_END_S + 5)], { buffs: preCastDance });
    expect(evaluateCastOutsideBuff(insideDance, ctx, FIELD_NEVER, 'warning')?.measured?.value).toBe('1 / 1');
  });

  it('leaves an off-side share under the field\'s own low end alone, since beating the field is not a mistake', () => {
    // A single on-side cast reads a 0% off-side share, under a field whose own low end sits at 50%.
    const ctx = ruleCtx([cast(SECRET_TECHNIQUE, DANCE_START_S + 2)], { buffs: dance });
    expect(evaluateCastOutsideBuff(insideDance, ctx, band(0.5, 0.9), 'warning', 'do x')).toBeNull();
  });
});

describe('evaluateAuraUptimeBelow', () => {
  const RUPTURE_MIN_PCT = 90;  // what the field holds, supplied as a measured band
  const ruptureUptime: AuraUptimeBelowCondition = {
    kind: 'aura_uptime_below', aura_spell_id: RUPTURE, aura_spell_name: 'Rupture', on: 'target',
  };
  // The context fight runs 0..120s, so a 60s span is 50% uptime.
  const halfUptime = [applyDebuff(RUPTURE, 0), removeDebuff(RUPTURE, 60)];

  it('flags uptime under the field\'s floor, measured against it', () => {
    const finding = evaluateAuraUptimeBelow(ruptureUptime, ruleCtx([], { debuffs: halfUptime }), band(RUPTURE_MIN_PCT), 'warning');
    expect(finding?.measured).toEqual({ value: `50 / ${RUPTURE_MIN_PCT}`, unit: '% uptime' });
  });

  it('passes uptime at or above the floor', () => {
    const nearFull = [applyDebuff(RUPTURE, 0), removeDebuff(RUPTURE, 115)];
    expect(evaluateAuraUptimeBelow(ruptureUptime, ruleCtx([], { debuffs: nearFull }), band(RUPTURE_MIN_PCT), 'warning')).toBeNull();
  });

  it('stays silent on zero uptime, which reads as a build that skips the aura', () => {
    expect(evaluateAuraUptimeBelow(ruptureUptime, ruleCtx([]), band(RUPTURE_MIN_PCT), 'warning')).toBeNull();
    expect(ruleApplicable(ruptureUptime, ruleCtx([]))).toBe(false);
  });

  it('reads the self stream when on is "self"', () => {
    const selfAura: AuraUptimeBelowCondition = { ...ruptureUptime, on: 'self' };
    const ctx = ruleCtx([], { buffs: [applyBuff(RUPTURE, 0), removeBuff(RUPTURE, 60)] });
    expect(evaluateAuraUptimeBelow(selfAura, ctx, band(RUPTURE_MIN_PCT), 'warning')?.measured?.value).toBe(`50 / ${RUPTURE_MIN_PCT}`);
  });

  it('measures uptime over the whole fight, so a 30s dot on a 120s pull reads 25%', () => {
    // 30 / 120 = 25%.
    const DOT_END_S = 30;
    const ctx = ruleCtx([], { debuffs: [applyDebuff(RUPTURE, 0), removeDebuff(RUPTURE, DOT_END_S)] });
    const finding = evaluateAuraUptimeBelow(ruptureUptime, ctx, band(RUPTURE_MIN_PCT), 'warning');
    expect(finding?.measured).toEqual({ value: `25 / ${RUPTURE_MIN_PCT}`, unit: '% uptime' });
  });

  it('reads a debuff applied before the pull as up from fight start, since it arrives as a lone remove', () => {
    const PRE_PULL_REMOVE_S = 20;  // fight runs 0..120s, so this back-fills to 20/120 = 17% uptime
    const ctx = ruleCtx([], { debuffs: [removeDebuff(RUPTURE, PRE_PULL_REMOVE_S)] });
    expect(evaluateAuraUptimeBelow(ruptureUptime, ctx, band(RUPTURE_MIN_PCT), 'warning')?.measured?.value)
      .toBe(`17 / ${RUPTURE_MIN_PCT}`);
    expect(ruleApplicable(ruptureUptime, ctx)).toBe(true);
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
    expect(evaluateCastOutsideBuff(insideDance, ctx, FIELD_NEVER, 'warning')).toBeNull();
  });

  it('reads that same cast as having consumed the proc', () => {
    const spendDance: ProcWastedCondition = {
      kind: 'proc_wasted', buff_spell_id: SHADOW_DANCE, buff_spell_name: 'Shadow Dance',
      spend_spell_ids: [SECRET_TECHNIQUE], spend_spell_names: ['Secret Technique'],
    };
    const ctx = ruleCtx([cast(SECRET_TECHNIQUE, DANCE_END_S)], { buffs: dance });
    expect(evaluateProcWasted(spendDance, ctx, FIELD_NEVER, 'warning')).toBeNull();
  });

  it('passes uptime exactly at the measured bar (strict below)', () => {
    const HALF_UPTIME_PCT = 50;
    const exactly: AuraUptimeBelowCondition = {
      kind: 'aura_uptime_below', aura_spell_id: RUPTURE, aura_spell_name: 'Rupture', on: 'target',
    };
    const ctx = ruleCtx([], { debuffs: [applyDebuff(RUPTURE, 0), removeDebuff(RUPTURE, 60)] });
    expect(evaluateAuraUptimeBelow(exactly, ctx, band(HALF_UPTIME_PCT), 'warning')).toBeNull();
  });

  it('accepts an opener step landing exactly on hi', () => {
    const OPENER_WINDOW_S = 12;
    const opener: OpeningSequenceCondition = {
      kind: 'opening_sequence', spell_ids: [SHADOW_BLADES, SECRET_TECHNIQUE],
      spell_names: ['Shadow Blades', 'Secret Technique'],
    };
    const ctx = ruleCtx([cast(SHADOW_BLADES, 0), cast(SECRET_TECHNIQUE, OPENER_WINDOW_S)]);
    expect(evaluateOpeningSequence(opener, ctx, band(OPENER_WINDOW_S), 'warning')).toBeNull();
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
    expect(evaluateOpeningSequence(opener, ctx, band(OPENER_WINDOW_S), 'warning')).toBeNull();
  });

  it('flags a sequence cast out of order, reporting the steps reached', () => {
    const ctx = ruleCtx([cast(SHADOW_BLADES, 1), cast(SECRET_TECHNIQUE, 3), cast(SHADOW_DANCE, 5)]);
    expect(evaluateOpeningSequence(opener, ctx, band(OPENER_WINDOW_S), 'warning')?.measured).toEqual({ value: '2 / 3', unit: 'step(s)' });
  });

  it('flags a step that lands past the opener window', () => {
    const ctx = ruleCtx([cast(SHADOW_BLADES, 1), cast(SHADOW_DANCE, 3), cast(SECRET_TECHNIQUE, OPENER_WINDOW_S + 5)]);
    expect(evaluateOpeningSequence(opener, ctx, band(OPENER_WINDOW_S), 'warning')?.measured?.value).toBe('2 / 3');
  });

  it('renders the window limit with one decimal, matching the pair and hold sentences', () => {
    const WINDOW_LIMIT_S = 12.4;
    const ctx = ruleCtx([cast(SHADOW_BLADES, 1), cast(SHADOW_DANCE, 3), cast(SECRET_TECHNIQUE, WINDOW_LIMIT_S + 5)]);
    expect(evaluateOpeningSequence(opener, ctx, band(WINDOW_LIMIT_S), 'warning')?.message)
      .toBe('Your opener got 2 of 3 steps out. Top raiders finish all 3 within 12.4s.');
  });

  it('tolerates unrelated casts between the steps', () => {
    const ctx = ruleCtx([cast(SHADOW_BLADES, 1), cast(EVISCERATE, 2), cast(SHADOW_DANCE, 3), cast(SECRET_TECHNIQUE, 5)]);
    expect(evaluateOpeningSequence(opener, ctx, band(OPENER_WINDOW_S), 'warning')).toBeNull();
  });

  it('is judged on neither side of a pull with none of the sequence spells', () => {
    const ctx = ruleCtx([cast(EVISCERATE, 1)]);
    const rule: RulebookRule = { severity: 'warning', condition: opener };
    expect(ruleApplicable(opener, ctx)).toBe(false);
    expect(evaluateRules([benched(rule, band(OPENER_WINDOW_S))], ctx)).toEqual([]);
    expect(rulesFollowed([benched(rule, band(OPENER_WINDOW_S))], ctx)).toEqual([]);
  });

  it('still flags a first step landing past the window, which is why the gate reads casts and not progress', () => {
    const ctx = ruleCtx([cast(EVISCERATE, 1), cast(SHADOW_BLADES, 30)]);
    const rule: RulebookRule = { severity: 'warning', condition: opener };
    expect(evaluateRules([benched(rule, band(OPENER_WINDOW_S))], ctx)[0].measured?.value).toBe('0 / 3');
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
    expect(evaluateCastAtTargetCount(blackPowder, ctx, band(TARGET_FLOOR), 'warning')?.measured?.value).toBe('1 / 1');
  });

  it('passes the same cast once enough enemies are hit', () => {
    const ctx = ruleCtx([cast(BLACK_POWDER, CAST_S)], { damage: hits([1, 2, 3]) });
    expect(evaluateCastAtTargetCount(blackPowder, ctx, band(TARGET_FLOOR), 'warning')).toBeNull();
  });

  it('flags a single-target ability pressed over its ceiling', () => {
    const FIELD_CEILING = 2;  // the field stops using it above this, measured
    const capped: CastAtTargetCountCondition = {
      kind: 'cast_at_target_count', spell_id: EVISCERATE, spell_name: 'Eviscerate', bound: 'max',
    };
    const ctx = ruleCtx([cast(EVISCERATE, CAST_S)],
      { damage: [1, 2, 3].map(id => damage(EVISCERATE, CAST_S + 1, 100, { target: id })) });
    expect(evaluateCastAtTargetCount(capped, ctx, band(FIELD_CEILING), 'warning')?.measured?.value).toBe('1 / 1');
  });

  it('accepts a cast exactly at the target ceiling but not one over it', () => {
    const FIELD_CEILING = 2;
    const capped: CastAtTargetCountCondition = {
      kind: 'cast_at_target_count', spell_id: EVISCERATE, spell_name: 'Eviscerate', bound: 'max',
    };
    const onCeiling = ruleCtx([cast(EVISCERATE, CAST_S)], { damage: [1, 2].map(id => damage(EVISCERATE, CAST_S + 1, 100, { target: id })) });
    const overCeiling = ruleCtx([cast(EVISCERATE, CAST_S)], { damage: [1, 2, 3].map(id => damage(EVISCERATE, CAST_S + 1, 100, { target: id })) });
    expect(evaluateCastAtTargetCount(capped, onCeiling, band(FIELD_CEILING), 'warning')).toBeNull();
    expect(evaluateCastAtTargetCount(capped, overCeiling, band(FIELD_CEILING), 'warning')).not.toBeNull();
  });

  it('counts copies of one add separately, since they share a targetID and differ only by instance', () => {
    const ADD_ID = 7;
    const copies = [1, 2, 3].map(instance =>
      ({ ...damage(BLACK_POWDER, CAST_S + 1, 100, { target: ADD_ID }), targetInstance: instance }));
    const ctx = ruleCtx([cast(BLACK_POWDER, CAST_S)], { damage: copies });
    expect(evaluateCastAtTargetCount(blackPowder, ctx, band(TARGET_FLOOR), 'warning')).toBeNull();
  });

  it('ignores a cast with no damage recorded near it, rather than reading it as zero targets', () => {
    const ctx = ruleCtx([cast(BLACK_POWDER, CAST_S)], { damage: hits([1, 2]).map(e => ({ ...e, timestamp: 90_000 })) });
    expect(evaluateCastAtTargetCount(blackPowder, ctx, band(TARGET_FLOOR), 'warning')).toBeNull();
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
    expect(evaluateCastAtTargetCount(capped, ctx, band(FIELD_CEILING), 'warning')?.measured?.value).toBe('1 / 1');
  });

  it('rounds a sub-target floor away, so a field whose true floor is 2.7 still flags a cast at 2', () => {
    const SUB_TARGET_FLOOR = 2.7;
    const ctx = ruleCtx([cast(BLACK_POWDER, CAST_S)], { damage: hits([1, 2]) });
    expect(evaluateCastAtTargetCount(blackPowder, ctx, band(SUB_TARGET_FLOOR), 'warning')?.measured?.value).toBe('1 / 1');
  });

  it('counts damage landing on the cast millisecond, which an instant ability does', () => {
    const onTheCast = [1, 2, 3].map(id => damage(BLACK_POWDER, CAST_S, 100, { target: id }));
    const ctx = ruleCtx([cast(BLACK_POWDER, CAST_S)], { damage: onTheCast });
    expect(evaluateCastAtTargetCount(blackPowder, ctx, band(TARGET_FLOOR), 'warning')).toBeNull();
  });

  it('bisects a sorted index, so a row logged out of order does not shift the window', () => {
    const EARLY_S = 1;
    const OTHER_ENEMY = 9;
    const rows = [...hits([1, 2]), damage(BLACK_POWDER, EARLY_S, 100, { target: OTHER_ENEMY }), ...hits([3])];
    const ctx = ruleCtx([cast(BLACK_POWDER, CAST_S)], { damage: rows });
    expect(evaluateCastAtTargetCount(blackPowder, ctx, band(TARGET_FLOOR), 'warning')).toBeNull();
  });

  it('folds rows that name no target into one enemy rather than dropping them', () => {
    const FIELD_CEILING = 0;  // any enemy at all is over this ceiling
    const capped: CastAtTargetCountCondition = { ...blackPowder, bound: 'max' };
    const ctx = ruleCtx([cast(BLACK_POWDER, CAST_S)], { damage: [damage(BLACK_POWDER, CAST_S + 1, 100)] });
    expect(evaluateCastAtTargetCount(capped, ctx, band(FIELD_CEILING), 'warning')?.measured?.value).toBe('1 / 1');
  });

  it('leaves a cast at far more targets than the field alone, since clearing a floor costs nothing', () => {
    const FIELD_LO = 2, FIELD_HI = 5;
    const overCast = ruleCtx([cast(BLACK_POWDER, CAST_S)], { damage: hits([1, 2, 3, 4, 5, 6, 7, 8]) });
    const atLo = ruleCtx([cast(BLACK_POWDER, CAST_S)], { damage: hits([1, 2]) });
    expect(evaluateCastAtTargetCount(blackPowder, overCast, band(FIELD_LO, FIELD_HI), 'warning', 'do x')).toBeNull();
    // Exactly on the floor is inside the field's range; only under it flags.
    expect(evaluateCastAtTargetCount(blackPowder, atLo, band(FIELD_LO, FIELD_HI), 'warning', 'do x')).toBeNull();
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

  it('flags a finisher spent below the field\'s floor', () => {
    const ctx = ruleCtx([atCombo(10, 3), atCombo(20, MAX_COMBO_POINTS)]);
    expect(evaluateResourceAtCast(finisherAtMax, ctx, band(RESOURCE_FLOOR), 'warning')?.measured).toEqual({ value: '1 / 2', unit: 'cast(s)' });
  });

  it('passes finishers spent at the floor', () => {
    expect(evaluateResourceAtCast(finisherAtMax, ruleCtx([atCombo(10, MAX_COMBO_POINTS)]), band(RESOURCE_FLOOR), 'warning')).toBeNull();
  });

  it('flags a generator pressed above its ceiling', () => {
    const FIELD_CEILING_FRAC = 0.8;  // the field generates below four fifths of the cap, measured
    const noOvercap: ResourceAtCastCondition = {
      kind: 'resource_at_cast', spell_id: BLACK_POWDER, spell_name: 'Black Powder',
      resource_type: COMBO_POINT_TYPE, resource_name: 'combo points', bound: 'max',
    };
    const ctx = ruleCtx([cast(BLACK_POWDER, 10,
      { resources: [{ amount: MAX_COMBO_POINTS, max: MAX_COMBO_POINTS, type: COMBO_POINT_TYPE }] })]);
    expect(evaluateResourceAtCast(noOvercap, ctx, band(FIELD_CEILING_FRAC), 'warning')?.measured?.value).toBe('1 / 1');
  });

  it('says the same thing in the chip and the sentence, so the two cannot drift', () => {
    const ctx = ruleCtx([atCombo(10, 3)]);
    const finding = evaluateResourceAtCast(finisherAtMax, ctx, band(RESOURCE_FLOOR), 'warning');
    expect(finding?.label).toBe('Eviscerate below 5/5 combo points');
    expect(finding?.message).toContain('Eviscerate casts were spent below 5/5 combo points');
  });

  it('quantizes the pool fraction back to the resource\'s own cap before it names the field\'s mark', () => {
    const TOP_FRAC = 0.8;  // a fraction other than 0 or 1, so quantizing must actually round it
    const ctx = ruleCtx([atCombo(10, 3), atCombo(20, MAX_COMBO_POINTS)]);
    // hi pinned at the pool's own cap so the full-pool cast does not itself trip the far side.
    const finding = evaluateResourceAtCast(finisherAtMax, ctx, band(TOP_FRAC, 1), 'warning');
    expect(finding?.message).toBe('1 of 2 Eviscerate casts were spent below 4/5 combo points. Spend at 4/5 or more.');
  });

  it('names the field\'s mark as a percent for a large pool (mana), the other branch of the scale', () => {
    const innervate: ResourceAtCastCondition = {
      kind: 'resource_at_cast', spell_id: EVISCERATE, spell_name: 'Innervate',
      resource_type: COMBO_POINT_TYPE, resource_name: 'mana', bound: 'min',
    };
    const MANA_MAX = 250_000;
    const TOP_FRAC = 0.75;
    const atMana = (atS: number, amount: number) =>
      cast(EVISCERATE, atS, { resources: [{ amount, max: MANA_MAX, type: COMBO_POINT_TYPE }] });
    const ctx = ruleCtx([atMana(10, MANA_MAX * 0.6), atMana(20, MANA_MAX)]);
    const finding = evaluateResourceAtCast(innervate, ctx, band(TOP_FRAC, 1), 'warning');
    expect(finding?.message).toBe('1 of 2 Innervate casts were spent below 75% mana. Spend at 75% or more.');
  });

  it('is not applicable when the casts carry no resource snapshot', () => {
    expect(evaluateResourceAtCast(finisherAtMax, ruleCtx([cast(EVISCERATE, 10)]), band(RESOURCE_FLOOR), 'warning')).toBeNull();
    expect(ruleApplicable(finisherAtMax, ruleCtx([cast(EVISCERATE, 10)]))).toBe(false);
  });

  it('ignores a pool the event flattened from the target rather than the caster', () => {
    const RESOURCE_ACTOR_TARGET = 2;
    const ctx = ruleCtx([{ ...atCombo(10, 1), resourceActor: RESOURCE_ACTOR_TARGET }]);
    expect(evaluateResourceAtCast(finisherAtMax, ctx, band(RESOURCE_FLOOR), 'warning')).toBeNull();
    expect(ruleApplicable(finisherAtMax, ctx)).toBe(false);
  });

  // Only a cast that spends the pool reports it, so every overcap rule judges a cast carrying no snapshot of its own.
  describe('a cast that spends nothing from the pool', () => {
    const OVERCAP_CEILING_FRAC = 0.6;  // the field generates below three fifths of the cap, measured
    const noOvercap: ResourceAtCastCondition = {
      kind: 'resource_at_cast', spell_id: BLACK_POWDER, spell_name: 'Black Powder',
      resource_type: COMBO_POINT_TYPE, resource_name: 'combo points', bound: 'max',
    };
    const SPENT_AT_S = 10;
    const finisher = cast(EVISCERATE, SPENT_AT_S,
      { resources: [{ amount: MAX_COMBO_POINTS, max: MAX_COMBO_POINTS, type: COMBO_POINT_TYPE, cost: MAX_COMBO_POINTS }] });

    it('reads the pool a neighbouring cast left behind', () => {
      const AT_CAP_S = 12;
      const atCap = cast(EVISCERATE, AT_CAP_S,
        { resources: [{ amount: MAX_COMBO_POINTS, max: MAX_COMBO_POINTS, type: COMBO_POINT_TYPE }] });
      const ctx = ruleCtx([atCap, cast(BLACK_POWDER, AT_CAP_S + 1)]);
      expect(evaluateResourceAtCast(noOvercap, ctx, band(OVERCAP_CEILING_FRAC), 'warning')?.measured?.value).toBe('1 / 1');
    });

    it('subtracts the neighbour\'s cost, so the pool it emptied does not read as full', () => {
      const ctx = ruleCtx([finisher, cast(BLACK_POWDER, SPENT_AT_S + 1)]);
      // lo pinned at 0 so the emptied pool does not itself trip the far side.
      expect(evaluateResourceAtCast(noOvercap, ctx, band(0, OVERCAP_CEILING_FRAC), 'warning')).toBeNull();
    });

    it('reads nothing from a neighbour further back than the sample window', () => {
      const PAST_WINDOW_S = 7;
      const atCap = cast(EVISCERATE, SPENT_AT_S,
        { resources: [{ amount: MAX_COMBO_POINTS, max: MAX_COMBO_POINTS, type: COMBO_POINT_TYPE }] });
      const ctx = ruleCtx([atCap, cast(BLACK_POWDER, SPENT_AT_S + PAST_WINDOW_S)]);
      expect(ruleApplicable(noOvercap, ctx)).toBe(false);
    });

    it('reads nothing from a neighbour that only follows it, which cannot describe the cast', () => {
      const atCap = cast(EVISCERATE, SPENT_AT_S,
        { resources: [{ amount: MAX_COMBO_POINTS, max: MAX_COMBO_POINTS, type: COMBO_POINT_TYPE }] });
      const ctx = ruleCtx([cast(BLACK_POWDER, SPENT_AT_S - 1), atCap]);
      expect(ruleApplicable(noOvercap, ctx)).toBe(false);
    });

    it('reads nothing from a neighbour reporting a different pool', () => {
      const ENERGY_TYPE = 3;
      const energyCast = cast(EVISCERATE, SPENT_AT_S, { resources: [{ amount: 100, max: 100, type: ENERGY_TYPE }] });
      const ctx = ruleCtx([energyCast, cast(BLACK_POWDER, SPENT_AT_S + 1)]);
      expect(ruleApplicable(noOvercap, ctx)).toBe(false);
    });
  });

  it('flags the far side: a finisher spent at the pool\'s own cap, over the field\'s own ceiling', () => {
    const FIELD_LO_FRAC = 0.4, FIELD_HI_FRAC = 0.8;
    const overCap = ruleCtx([atCombo(10, MAX_COMBO_POINTS)]);
    const atHi = ruleCtx([atCombo(10, 4)]);
    const finding = evaluateResourceAtCast(finisherAtMax, overCap, band(FIELD_LO_FRAC, FIELD_HI_FRAC), 'warning', 'do x');
    expect(finding?.message).toBe('1 of 1 Eviscerate casts were spent above 4/5 combo points. Spend before you cap.');
    // Spending sooner is what the authored action asks for, and it answers a capped pool too.
    expect(finding?.details?.remedy).toBe('do x');
    expect(evaluateResourceAtCast(finisherAtMax, atHi, band(FIELD_LO_FRAC, FIELD_HI_FRAC), 'warning', 'do x')).toBeNull();
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
    expect(evaluateProcWasted(spendDance, ctx, FIELD_NEVER, 'warning')?.measured).toEqual({ value: '1 / 1', unit: 'proc(s)' });
  });

  it('passes a proc consumed inside its span', () => {
    const ctx = ruleCtx([cast(SECRET_TECHNIQUE, DANCE_START_S + 2)], { buffs: dance });
    expect(evaluateProcWasted(spendDance, ctx, FIELD_NEVER, 'warning')).toBeNull();
  });

  it('ignores a span still open at the end of the pull', () => {
    const ctx = ruleCtx([], { buffs: [applyBuff(SHADOW_DANCE, DANCE_START_S)] });
    expect(evaluateProcWasted(spendDance, ctx, FIELD_NEVER, 'warning')).toBeNull();
    expect(ruleApplicable(spendDance, ctx)).toBe(false);
  });

  it('ignores a span the log closes on the pull ending, which the kill took rather than the player wasting', () => {
    const ctx = ruleCtx([], { buffs: buffWindow(SHADOW_DANCE, 100, RULE_FIGHT_END_S) });
    expect(evaluateProcWasted(spendDance, ctx, FIELD_NEVER, 'warning')).toBeNull();
    expect(ruleApplicable(spendDance, ctx)).toBe(false);
  });

  it('leaves a wasted share under the field\'s own low end alone, since wasting fewer procs is not a mistake', () => {
    const ctx = ruleCtx([cast(SECRET_TECHNIQUE, DANCE_START_S + 2)], { buffs: dance });
    expect(evaluateProcWasted(spendDance, ctx, band(0.5, 0.9), 'warning', 'do x')).toBeNull();
  });
});

describe('evaluateFillerInBuff', () => {
  // Fight-relative seconds for an Eclipse (Solar) window long enough to hold several fillers.
  const SOLAR_START_S = 10, SOLAR_END_S = 40;
  // What the field runs: Wrath is nearly every filler pressed inside Solar Eclipse.
  const FIELD_WRATH_SHARE = 0.9;
  const wrathInSolar: FillerInBuffCondition = {
    kind: 'filler_in_buff',
    spell_id: WRATH, spell_name: 'Wrath',
    alternative_spell_ids: [STARFIRE], alternative_spell_names: ['Starfire'],
    buff_spell_id: ECLIPSE_SOLAR, buff_spell_name: 'Eclipse (Solar)',
  };
  const solar = buffWindow(ECLIPSE_SOLAR, SOLAR_START_S, SOLAR_END_S);
  // hi pinned at 1 (the share's own domain max) so a full-share pass never trips the far side.
  const fieldFloor = band(FIELD_WRATH_SHARE, 1);

  it('flags a player filling with the wrong spell inside the buff', () => {
    // One Wrath to three Starfire is a 25% share, under the field's 90%.
    const ctx = ruleCtx([
      cast(WRATH, 12), cast(STARFIRE, 14), cast(STARFIRE, 16), cast(STARFIRE, 18),
    ], { buffs: solar });
    expect(evaluateFillerInBuff(wrathInSolar, ctx, fieldFloor, 'warning')?.measured)
      .toEqual({ value: '25 / 90', unit: '% of fillers' });
  });

  it('passes a player whose share matches the field', () => {
    const ctx = ruleCtx([cast(WRATH, 12), cast(WRATH, 14), cast(WRATH, 16)], { buffs: solar });
    expect(evaluateFillerInBuff(wrathInSolar, ctx, fieldFloor, 'warning')).toBeNull();
  });

  it('ignores fillers cast outside the buff, which the rule says nothing about', () => {
    const ctx = ruleCtx([cast(WRATH, 12), cast(STARFIRE, SOLAR_END_S + 5)], { buffs: solar });
    expect(evaluateFillerInBuff(wrathInSolar, ctx, fieldFloor, 'warning')).toBeNull();
  });

  it('accepts a share exactly on the field floor but not one just under it', () => {
    // Nine Wrath to one Starfire is exactly 90%; eight to two is 80%.
    const nine = Array.from({ length: 9 }, (_, i) => cast(WRATH, 12 + i));
    const eight = Array.from({ length: 8 }, (_, i) => cast(WRATH, 12 + i));
    const onTheBar = ruleCtx([...nine, cast(STARFIRE, 22)], { buffs: solar });
    const underIt = ruleCtx([...eight, cast(STARFIRE, 22), cast(STARFIRE, 24)], { buffs: solar });
    expect(evaluateFillerInBuff(wrathInSolar, onTheBar, fieldFloor, 'warning')).toBeNull();
    expect(evaluateFillerInBuff(wrathInSolar, underIt, fieldFloor, 'warning')).not.toBeNull();
  });

  it('is not applicable when the pull never filled inside the buff', () => {
    expect(ruleApplicable(wrathInSolar, ruleCtx([cast(WRATH, 5)], { buffs: solar }))).toBe(false);
  });

  it('excludes the cast that enters the state, which shares the applybuff timestamp but was cast outside it', () => {
    // The Starfire that grants Solar lands on the same millisecond as the buff, and it was not cast under it.
    const entering = ruleCtx([cast(STARFIRE, SOLAR_START_S)], { buffs: solar });
    expect(ruleApplicable(wrathInSolar, entering)).toBe(false);
    // The removal millisecond stays inside: a cast that consumes the state was made under it.
    const closing = ruleCtx([cast(STARFIRE, SOLAR_END_S)], { buffs: solar });
    expect(ruleApplicable(wrathInSolar, closing)).toBe(true);
  });

  it('drops casts made in a state that suspends the choice, so a burst window is not a violation', () => {
    const CELESTIAL_START_S = 15, CELESTIAL_END_S = 25;
    const suspendedByCelestial: FillerInBuffCondition = {
      ...wrathInSolar,
      except_buff_spell_ids: [SHADOW_DANCE], except_buff_spell_names: ['Celestial Alignment'],
    };
    const buffs = [...solar, ...buffWindow(SHADOW_DANCE, CELESTIAL_START_S, CELESTIAL_END_S)];
    // Three Starfire inside the suspending window, one Wrath outside it.
    const ctx = ruleCtx([
      cast(WRATH, 12), cast(STARFIRE, 16), cast(STARFIRE, 18), cast(STARFIRE, 20),
    ], { buffs });
    expect(evaluateFillerInBuff(suspendedByCelestial, ctx, fieldFloor, 'warning')).toBeNull();
    expect(evaluateFillerInBuff(wrathInSolar, ctx, fieldFloor, 'warning')).not.toBeNull();
  });

  it('is not applicable when every filler inside the buff sat in a suspending state', () => {
    const suspendedThroughout: FillerInBuffCondition = {
      ...wrathInSolar,
      except_buff_spell_ids: [SHADOW_DANCE], except_buff_spell_names: ['Celestial Alignment'],
    };
    const buffs = [...solar, ...buffWindow(SHADOW_DANCE, SOLAR_START_S, SOLAR_END_S)];
    const ctx = ruleCtx([cast(WRATH, 12), cast(STARFIRE, 16)], { buffs });
    expect(ruleApplicable(suspendedThroughout, ctx)).toBe(false);
    expect(sampleRule(suspendedThroughout, ctx).values).toEqual([]);
  });

  it('samples the share the pull ran, and nothing when it never filled inside the buff', () => {
    const ctx = ruleCtx([cast(WRATH, 12), cast(WRATH, 14), cast(STARFIRE, 16), cast(STARFIRE, 18)], { buffs: solar });
    expect(sampleRule(wrathInSolar, ctx).values).toEqual([0.5]);
    expect(sampleRule(wrathInSolar, ruleCtx([], { buffs: solar })).values).toEqual([]);
  });

  it('a lower field floor forgives a share a tighter one would flag', () => {
    const ctx = ruleCtx([cast(WRATH, 12), cast(WRATH, 14), cast(WRATH, 16), cast(STARFIRE, 18)], { buffs: solar });
    // Three Wrath to one Starfire is 75%.
    expect(evaluateFillerInBuff(wrathInSolar, ctx, band(0.7, 1), 'warning')).toBeNull();
    expect(evaluateFillerInBuff(wrathInSolar, ctx, fieldFloor, 'warning')).not.toBeNull();
  });

  it('leaves a coached share over the field\'s own high end alone, since running the coached filler more is not a mistake', () => {
    const ctx = ruleCtx([cast(WRATH, 12), cast(WRATH, 14), cast(WRATH, 16)], { buffs: solar });
    expect(evaluateFillerInBuff(wrathInSolar, ctx, band(0.5, 0.9), 'warning', 'do x')).toBeNull();
  });

  it('labels the rule as "<filler> in <buff>"', () => {
    expect(ruleLabel(wrathInSolar)).toBe('Wrath in Eclipse (Solar)');
  });
});

describe('evaluateSpendAtStacks', () => {
  // What the field holds before spending, supplied as a measured band.
  const FIELD_STACKS = 8;
  // Top of the `climbing` fixture below, standing in for the buff's own cap.
  const MAELSTROM_WEAPON_MAX_STACKS = 10;
  const spendAtStacks: SpendAtStacksCondition = {
    kind: 'spend_at_stacks',
    spell_id: LIGHTNING_BOLT, spell_name: 'Lightning Bolt',
    buff_spell_id: MAELSTROM_WEAPON, buff_spell_name: 'Maelstrom Weapon',
    bound: 'min', max_stacks: MAELSTROM_WEAPON_MAX_STACKS,
  };
  // One stack lands each second from t=1.
  const climbing = [applyBuff(MAELSTROM_WEAPON, 1), ...Array.from({ length: 9 }, (_, i) => applyBuffStack(MAELSTROM_WEAPON, i + 2, i + 2))];
  // The count read is the one in force GOING INTO the cast, so a cast one second after the Nth stack holds N.
  const holding = (stacks: number) => stacks + 1;

  it('flags a spender pressed below the count the field waits for', () => {
    const ctx = ruleCtx([cast(LIGHTNING_BOLT, holding(3))], { buffs: climbing });
    expect(evaluateSpendAtStacks(spendAtStacks, ctx, band(FIELD_STACKS), 'warning')?.measured)
      .toEqual({ value: '1 / 1', unit: 'cast(s)' });
  });

  it('passes a spender pressed at the field count, and flags one a stack below it', () => {
    const onCount = ruleCtx([cast(LIGHTNING_BOLT, holding(FIELD_STACKS))], { buffs: climbing });
    const underIt = ruleCtx([cast(LIGHTNING_BOLT, holding(FIELD_STACKS - 1))], { buffs: climbing });
    expect(evaluateSpendAtStacks(spendAtStacks, onCount, band(FIELD_STACKS), 'warning')).toBeNull();
    expect(evaluateSpendAtStacks(spendAtStacks, underIt, band(FIELD_STACKS), 'warning')).not.toBeNull();
  });

  it('reads the count going into the cast, since a spend and the cast that spends it share one timestamp', () => {
    const SPEND_AT_S = 6, STACKS_HELD = SPEND_AT_S - 1;
    const buffs = [
      applyBuff(MAELSTROM_WEAPON, 1),
      ...Array.from({ length: STACKS_HELD - 1 }, (_, i) => applyBuffStack(MAELSTROM_WEAPON, i + 2, i + 2)),
      removeBuff(MAELSTROM_WEAPON, SPEND_AT_S),
    ];
    const ctx = ruleCtx([cast(LIGHTNING_BOLT, SPEND_AT_S)], { buffs });
    // Reading the post-consumption value would see 0 here and flag every spend in the log.
    expect(sampleRule(spendAtStacks, ctx).values).toEqual([STACKS_HELD]);
  });

  it('inverts for bound "max", flagging a generator pressed while the buff is nearly capped', () => {
    const generateAtCap: SpendAtStacksCondition = { ...spendAtStacks, bound: 'max' };
    // The field generates at 3; this cast holds 9.
    const FIELD_GENERATES_AT = 3;
    const ctx = ruleCtx([cast(LIGHTNING_BOLT, holding(9))], { buffs: climbing });
    // The ceiling assertion pins lo at 0 so 9 cannot also trip the far side; the floor assertion pins hi past 9 for the same reason.
    expect(evaluateSpendAtStacks(generateAtCap, ctx, band(0, FIELD_GENERATES_AT), 'warning')?.message)
      .toContain('overcapping');
    expect(evaluateSpendAtStacks(spendAtStacks, ctx, band(FIELD_GENERATES_AT, MAELSTROM_WEAPON_MAX_STACKS), 'warning')).toBeNull();
  });

  it('drops casts made in a state that suspends the rule', () => {
    const suspended: SpendAtStacksCondition = {
      ...spendAtStacks, except_buff_spell_ids: [SHADOW_DANCE], except_buff_spell_names: ['Ascendance'],
    };
    const buffs = [...climbing, ...buffWindow(SHADOW_DANCE, 3, 6)];
    const ctx = ruleCtx([cast(LIGHTNING_BOLT, holding(3))], { buffs });
    expect(evaluateSpendAtStacks(suspended, ctx, band(FIELD_STACKS), 'warning')).toBeNull();
    expect(evaluateSpendAtStacks(spendAtStacks, ctx, band(FIELD_STACKS), 'warning')).not.toBeNull();
  });

  it('is not applicable on a build where the buff never appeared', () => {
    expect(ruleApplicable(spendAtStacks, ruleCtx([cast(LIGHTNING_BOLT, 4)]))).toBe(false);
  });

  it('is not applicable when every cast falls before the buff\'s first recorded trace, so nothing is measurable', () => {
    const PRE_PULL_DROP_S = 5; // the buff was already up at pull; its first trace is this bare remove
    const buffs = [removeBuff(MAELSTROM_WEAPON, PRE_PULL_DROP_S)];
    const ctx = ruleCtx([cast(LIGHTNING_BOLT, PRE_PULL_DROP_S - 1)], { buffs });
    const rule: RulebookRule = { severity: 'warning', description: 'spend at stacks', condition: spendAtStacks };
    expect(ruleApplicable(spendAtStacks, ctx)).toBe(false);
    expect(evaluateRules([benched(rule)], ctx)).toEqual([]);
    expect(rulesFollowed([benched(rule)], ctx)).toEqual([]);
  });

  it('does not flag an opener spent under a buff already up at pull, but still flags a genuine low-stack spend later', () => {
    const PRE_PULL_DROP_S = 2; // the buff was already up at pull; its first trace is this bare remove
    const LATER_APPLY_S = 10, LATER_SPEND_S = 12; // a fresh application later in the pull, spent cheap
    const buffs = [
      removeBuff(MAELSTROM_WEAPON, PRE_PULL_DROP_S),
      applyBuff(MAELSTROM_WEAPON, LATER_APPLY_S),
      applyBuffStack(MAELSTROM_WEAPON, LATER_APPLY_S + 1, 2),
    ];
    const opener = ruleCtx([cast(LIGHTNING_BOLT, PRE_PULL_DROP_S - 1)], { buffs });
    const laterCheapSpend = ruleCtx([cast(LIGHTNING_BOLT, LATER_SPEND_S)], { buffs });
    expect(evaluateSpendAtStacks(spendAtStacks, opener, band(FIELD_STACKS), 'warning')).toBeNull();
    expect(evaluateSpendAtStacks(spendAtStacks, laterCheapSpend, band(FIELD_STACKS), 'warning')).not.toBeNull();
  });

  it('samples every spend\'s own stack count, so the field-wide pool - not a per-parse reduction - finds the floor', () => {
    const ctx = ruleCtx([cast(LIGHTNING_BOLT, holding(3)), cast(LIGHTNING_BOLT, holding(9))], { buffs: climbing });
    expect(sampleRule(spendAtStacks, ctx).values).toEqual([3, 9]);
    expect(sampleRule(spendAtStacks, ruleCtx([], { buffs: climbing })).values).toEqual([]);
  });

  it('samples a cast made before the first stack landed as zero, not as unmeasured', () => {
    const BEFORE_FIRST_STACK_S = 0.5;
    const ctx = ruleCtx([cast(LIGHTNING_BOLT, BEFORE_FIRST_STACK_S), cast(LIGHTNING_BOLT, holding(9))], { buffs: climbing });
    expect(sampleRule(spendAtStacks, ctx).values).toEqual([0, 9]);
  });

  it('flags a spend below the field floor and passes one exactly on it', () => {
    const FLOOR = 5;
    const onFloor = ruleCtx([cast(LIGHTNING_BOLT, holding(FLOOR))], { buffs: climbing });
    const underFloor = ruleCtx([cast(LIGHTNING_BOLT, holding(FLOOR - 1))], { buffs: climbing });
    expect(evaluateSpendAtStacks(spendAtStacks, onFloor, band(FLOOR), 'warning')).toBeNull();
    expect(evaluateSpendAtStacks(spendAtStacks, underFloor, band(FLOOR), 'warning')).not.toBeNull();
  });

  it('does not fire at exactly the tolerance share, and fires one instance past it (strict)', () => {
    const TOLERANCE = 0.2;
    const FLOOR = 8;
    // Strictly inside (FLOOR - 1, FLOOR) reads FLOOR - 1 (a violation); strictly inside (FLOOR, FLOOR + 1) reads FLOOR.
    const belowTime = (i: number) => FLOOR - 1 + 0.5 + i / 100;
    const atFloorTime = (i: number) => FLOOR + 0.5 + i / 100;
    const scenario = (belowCount: number) => ruleCtx([
      ...Array.from({ length: belowCount }, (_, i) => cast(LIGHTNING_BOLT, belowTime(i))),
      ...Array.from({ length: 10 - belowCount }, (_, i) => cast(LIGHTNING_BOLT, atFloorTime(i))),
    ], { buffs: climbing });
    // 2 of 10 below the floor: 2 > 10 * 0.2 is false.
    expect(evaluateSpendAtStacks(spendAtStacks, scenario(2), band(FLOOR, FLOOR, TOLERANCE), 'warning')).toBeNull();
    // 3 of 10 below the floor: 3 > 10 * 0.2 is true.
    expect(evaluateSpendAtStacks(spendAtStacks, scenario(3), band(FLOOR, FLOOR, TOLERANCE), 'warning')).not.toBeNull();
  });

  it('labels the rule as "<spender> at <buff>"', () => {
    expect(ruleLabel(spendAtStacks)).toBe('Lightning Bolt at Maelstrom Weapon');
  });

  it('flags the far side: a spender held to the buff\'s own cap, over the field\'s own ceiling', () => {
    const FIELD_LO = 3, FIELD_HI = 8;
    const overCap = ruleCtx([cast(LIGHTNING_BOLT, holding(MAELSTROM_WEAPON_MAX_STACKS))], { buffs: climbing });
    const atHi = ruleCtx([cast(LIGHTNING_BOLT, holding(FIELD_HI))], { buffs: climbing });
    const finding = evaluateSpendAtStacks(spendAtStacks, overCap, band(FIELD_LO, FIELD_HI), 'warning', 'do x');
    expect(finding?.message).toBe('1 of 1 Lightning Bolt casts were held past 8/10 stacks of Maelstrom Weapon. Spend before you cap.');
    expect(finding?.details?.remedy).toBe('do x');
    expect(evaluateSpendAtStacks(spendAtStacks, atHi, band(FIELD_LO, FIELD_HI), 'warning', 'do x')).toBeNull();
  });
});

describe('evaluateAuraClipped', () => {
  // Where the field refreshes: it lets the dot run this long before re-applying.
  const FIELD_ELAPSED_S = 12;
  const moonfireClipped: AuraClippedCondition = {
    kind: 'aura_clipped',
    aura_spell_id: MOONFIRE_DOT, aura_spell_name: 'Moonfire',
    cast_spell_id: MOONFIRE, cast_spell_name: 'Moonfire', on: 'target',
  };
  const APPLY_AT_S = 20, CLIPPED_ELAPSED_S = 4;
  const reapplied = (elapsed: number) => [applyDebuff(MOONFIRE_DOT, APPLY_AT_S), refreshDebuff(MOONFIRE_DOT, APPLY_AT_S + elapsed)];

  it('flags a refresh the player cast well before the field would have', () => {
    const ctx = ruleCtx([cast(MOONFIRE, APPLY_AT_S + CLIPPED_ELAPSED_S)], { debuffs: reapplied(CLIPPED_ELAPSED_S) });
    expect(evaluateAuraClipped(moonfireClipped, ctx, band(FIELD_ELAPSED_S), 'warning')?.measured)
      .toEqual({ value: '1 / 1', unit: 'refresh(es)' });
  });

  it('accepts a refresh exactly at the field bar but not one a second inside it', () => {
    const at = (elapsed: number) =>
      ruleCtx([cast(MOONFIRE, APPLY_AT_S + elapsed)], { debuffs: reapplied(elapsed) });
    expect(evaluateAuraClipped(moonfireClipped, at(FIELD_ELAPSED_S), band(FIELD_ELAPSED_S), 'warning')).toBeNull();
    expect(evaluateAuraClipped(moonfireClipped, at(FIELD_ELAPSED_S - 1), band(FIELD_ELAPSED_S), 'warning')).not.toBeNull();
  });

  it('leaves a refresh later than the field\'s own high end alone, since letting the aura run is not clipping it', () => {
    const LATE_ELAPSED_S = 20;
    const ctx = ruleCtx([cast(MOONFIRE, APPLY_AT_S + LATE_ELAPSED_S)], { debuffs: reapplied(LATE_ELAPSED_S) });
    expect(evaluateAuraClipped(moonfireClipped, ctx, band(4, 12), 'warning', 'do x')).toBeNull();
  });

  it('ignores a refresh no cast produced, since most refreshes in a log are procs', () => {
    const ctx = ruleCtx([], { debuffs: reapplied(CLIPPED_ELAPSED_S) });
    expect(evaluateAuraClipped(moonfireClipped, ctx, band(FIELD_ELAPSED_S), 'warning')).toBeNull();
    expect(ruleApplicable(moonfireClipped, ctx)).toBe(false);
  });

  it('ignores a bare refresh with no known prior application, since the true elapsed time is unknown', () => {
    const ctx = ruleCtx([cast(MOONFIRE, APPLY_AT_S)], { debuffs: [refreshDebuff(MOONFIRE_DOT, APPLY_AT_S)] });
    expect(evaluateAuraClipped(moonfireClipped, ctx, band(FIELD_ELAPSED_S), 'warning')).toBeNull();
    expect(ruleApplicable(moonfireClipped, ctx)).toBe(false);
  });

  it('ignores a cast that came after the refresh, which cannot have caused it', () => {
    const LATER_S = 0.1;
    const ctx = ruleCtx([cast(MOONFIRE, APPLY_AT_S + CLIPPED_ELAPSED_S + LATER_S)], { debuffs: reapplied(CLIPPED_ELAPSED_S) });
    expect(ruleApplicable(moonfireClipped, ctx)).toBe(false);
  });

  it('drops a refresh made in a state that suspends the rule', () => {
    const suspended: AuraClippedCondition = {
      ...moonfireClipped, except_buff_spell_ids: [SHADOW_DANCE], except_buff_spell_names: ['Celestial Alignment'],
    };
    const ctx = ruleCtx([cast(MOONFIRE, APPLY_AT_S + CLIPPED_ELAPSED_S)], {
      debuffs: reapplied(CLIPPED_ELAPSED_S),
      buffs: buffWindow(SHADOW_DANCE, APPLY_AT_S, APPLY_AT_S + 10),
    });
    expect(ruleApplicable(suspended, ctx)).toBe(false);
    expect(ruleApplicable(moonfireClipped, ctx)).toBe(true);
  });

  it('keeps each enemy on its own clock, so a second target is not measured against the first', () => {
    const OTHER_ENEMY = 77, SECOND_APPLY_S = 30;
    const debuffs = [
      applyDebuff(MOONFIRE_DOT, APPLY_AT_S),
      applyDebuff(MOONFIRE_DOT, SECOND_APPLY_S, { target: OTHER_ENEMY }),
      refreshDebuff(MOONFIRE_DOT, SECOND_APPLY_S + CLIPPED_ELAPSED_S, { target: OTHER_ENEMY }),
    ];
    const ctx = ruleCtx([cast(MOONFIRE, SECOND_APPLY_S + CLIPPED_ELAPSED_S)], { debuffs });
    // Its own clock reads 4s; measured against the first enemy's application it would read 14s.
    expect(sampleRule(moonfireClipped, ctx).values).toEqual([CLIPPED_ELAPSED_S]);
  });

  it('samples the earliest and latest the pull re-applied, and nothing when it never did', () => {
    const LATE_ELAPSED_S = 10;
    const debuffs = [
      ...reapplied(CLIPPED_ELAPSED_S),
      refreshDebuff(MOONFIRE_DOT, APPLY_AT_S + CLIPPED_ELAPSED_S + LATE_ELAPSED_S),
    ];
    const ctx = ruleCtx([
      cast(MOONFIRE, APPLY_AT_S + CLIPPED_ELAPSED_S), cast(MOONFIRE, APPLY_AT_S + CLIPPED_ELAPSED_S + LATE_ELAPSED_S),
    ], { debuffs });
    expect(sampleRule(moonfireClipped, ctx).values).toEqual([CLIPPED_ELAPSED_S, LATE_ELAPSED_S]);
    expect(sampleRule(moonfireClipped, ruleCtx([])).values).toEqual([]);
  });

  it('labels the rule as "<aura> clipped"', () => {
    expect(ruleLabel(moonfireClipped)).toBe('Moonfire clipped');
  });
});

describe('evaluateFillerBelowHealth', () => {
  const EXECUTE_PCT = 20;
  // What the field runs: nearly every filler below the threshold is the execute ability.
  const FIELD_EXECUTE_SHARE = 0.95;
  const executeBelow: FillerBelowHealthCondition = {
    kind: 'filler_below_health',
    spell_id: EXECUTE, spell_name: 'Execute',
    alternative_spell_ids: [SLAM], alternative_spell_names: ['Slam'],
    health_pct: EXECUTE_PCT,
  };
  // hi pinned at 1 so a fully-converted pass never trips the far side.
  const fieldFloor = band(FIELD_EXECUTE_SHARE, 1);
  // Health rides on damage rows, so each cast reads the last hit on the enemy it named.
  const hitAt = (atS: number, healthPct: number, target?: number) =>
    damage(SHADOW_BLADES_DAMAGE, atS, 1, { targetHealthPct: healthPct, ...(target !== undefined && { target }) });
  const EXECUTE_RANGE_PCT = 15, HEALTHY_PCT = 80;
  const HIT_S = 100;

  it('flags a player still pressing the wrong filler under the threshold', () => {
    const ctx = ruleCtx([cast(EXECUTE, HIT_S + 0.5), cast(SLAM, HIT_S + 1), cast(SLAM, HIT_S + 1.5)],
      { damage: [hitAt(HIT_S, EXECUTE_RANGE_PCT)] });
    expect(evaluateFillerBelowHealth(executeBelow, ctx, fieldFloor, 'warning')?.measured)
      .toEqual({ value: '33 / 95', unit: '% of fillers' });
  });

  it('passes a player converting every filler under the threshold', () => {
    const ctx = ruleCtx([cast(EXECUTE, HIT_S + 0.5), cast(EXECUTE, HIT_S + 1)], { damage: [hitAt(HIT_S, EXECUTE_RANGE_PCT)] });
    expect(evaluateFillerBelowHealth(executeBelow, ctx, fieldFloor, 'warning')).toBeNull();
  });

  it('ignores fillers cast above the threshold, which the rule says nothing about', () => {
    const ctx = ruleCtx([cast(SLAM, HIT_S + 0.5)], { damage: [hitAt(HIT_S, HEALTHY_PCT)] });
    expect(evaluateFillerBelowHealth(executeBelow, ctx, fieldFloor, 'warning')).toBeNull();
    expect(ruleApplicable(executeBelow, ctx)).toBe(false);
  });

  it('reads the health of the enemy the cast named, not whichever enemy was hit last', () => {
    const BOSS = 1, DYING_ADD = 2;
    // The add is at 15% and the boss at 80%; a Slam into the boss must not count as an execute-range filler.
    const ctx = ruleCtx([cast(SLAM, HIT_S + 1, { target: BOSS })], {
      damage: [hitAt(HIT_S, HEALTHY_PCT, BOSS), hitAt(HIT_S + 0.5, EXECUTE_RANGE_PCT, DYING_ADD)],
    });
    expect(ruleApplicable(executeBelow, ctx)).toBe(false);
  });

  it('is not applicable on a pull with no health reading to place the casts', () => {
    expect(ruleApplicable(executeBelow, ruleCtx([cast(SLAM, HIT_S)]))).toBe(false);
  });

  it('reads the newest snapshot at or before the cast, so a stale row does not outrank a fresh one', () => {
    const ctx = ruleCtx([cast(SLAM, HIT_S + 1)],
      { damage: [hitAt(HIT_S + 0.5, EXECUTE_RANGE_PCT), hitAt(HIT_S, HEALTHY_PCT)] });
    expect(ruleApplicable(executeBelow, ctx)).toBe(true);
  });

  it('ignores a snapshot older than the sample window, since health falls fast in execute range', () => {
    const STALE_S = 3;
    const ctx = ruleCtx([cast(SLAM, HIT_S + STALE_S)], { damage: [hitAt(HIT_S, EXECUTE_RANGE_PCT)] });
    expect(ruleApplicable(executeBelow, ctx)).toBe(false);
  });

  it('samples the share the pull converted, and nothing when it never reached the threshold', () => {
    const ctx = ruleCtx([cast(EXECUTE, HIT_S + 0.5), cast(SLAM, HIT_S + 1)], { damage: [hitAt(HIT_S, EXECUTE_RANGE_PCT)] });
    expect(sampleRule(executeBelow, ctx).values).toEqual([0.5]);
    expect(sampleRule(executeBelow, ruleCtx([cast(SLAM, HIT_S + 0.5)], { damage: [hitAt(HIT_S, HEALTHY_PCT)] })).values).toEqual([]);
  });

  it('leaves a coached share over the field\'s own high end alone, since converting more often is not a mistake', () => {
    const ctx = ruleCtx([cast(EXECUTE, HIT_S + 0.5), cast(EXECUTE, HIT_S + 1)], { damage: [hitAt(HIT_S, EXECUTE_RANGE_PCT)] });
    expect(evaluateFillerBelowHealth(executeBelow, ctx, band(0.5, 0.9), 'warning', 'do x')).toBeNull();
  });

  it('labels the rule as "<spell> under <pct>% health"', () => {
    expect(ruleLabel(executeBelow)).toBe('Execute under 20% health');
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

describe('sampleRule', () => {
  it('samples every paired cast\'s own lead, one instance per pairing', () => {
    const TIGHT_LEAD_S = 2, LOOSE_LEAD_S = 6;
    const ctx = ruleCtx([
      cast(SHADOW_DANCE, 10), cast(SECRET_TECHNIQUE, 10 + TIGHT_LEAD_S),
      cast(SHADOW_DANCE, 40), cast(SECRET_TECHNIQUE, 40 + LOOSE_LEAD_S),
    ]);
    expect(sampleRule(SECRET_TECH_NEEDS_DANCE, ctx).values).toEqual([TIGHT_LEAD_S, LOOSE_LEAD_S]);
  });

  it('measures no lead for an unpaired cast, but still reports it as an instance the parse judged', () => {
    expect(sampleRule(SECRET_TECH_NEEDS_DANCE, ruleCtx([cast(SECRET_TECHNIQUE, 10)])))
      .toEqual({ values: [], unmeasuredOut: 1 });
  });

  it('samples the gap each judged cast keeps clear before its next non-opener anchor', () => {
    const CLEAR_GAP_S = 30;
    const ctx = ruleCtx([
      cast(SHADOW_BLADES, 10), cast(SHADOW_DANCE, 90), cast(SHADOW_BLADES, 90 + CLEAR_GAP_S),
    ]);
    expect(sampleRule(HOLD_DANCE_FOR_BLADES, ctx).values).toEqual([CLEAR_GAP_S]);
  });

  it('samples the uptime the pull held for an aura rule', () => {
    const uptime: AuraUptimeBelowCondition = {
      kind: 'aura_uptime_below', aura_spell_id: RUPTURE, aura_spell_name: 'Rupture', on: 'target',
    };
    const ctx = ruleCtx([], { debuffs: [applyDebuff(RUPTURE, 0), removeDebuff(RUPTURE, 60)] });
    expect(sampleRule(uptime, ctx).values).toEqual([50]);
  });

  it('samples the share of procs the parse let expire, so a lasting state is not read as a wasted proc', () => {
    const proc: ProcWastedCondition = {
      kind: 'proc_wasted', buff_spell_id: SHADOW_DANCE, buff_spell_name: 'Shadow Dance',
      spend_spell_ids: [SECRET_TECHNIQUE], spend_spell_names: ['Secret Technique'],
    };
    const buffs = [...buffWindow(SHADOW_DANCE, 10, 20), ...buffWindow(SHADOW_DANCE, 30, 40)];
    const HALF_WASTED = 0.5;
    expect(sampleRule(proc, ruleCtx([cast(SECRET_TECHNIQUE, 12)], { buffs })).values).toEqual([HALF_WASTED]);
  });

  it('samples nothing for a proc that never closed a span, so the parse abstains rather than voting zero', () => {
    const proc: ProcWastedCondition = {
      kind: 'proc_wasted', buff_spell_id: SHADOW_DANCE, buff_spell_name: 'Shadow Dance',
      spend_spell_ids: [SECRET_TECHNIQUE], spend_spell_names: ['Secret Technique'],
    };
    expect(sampleRule(proc, ruleCtx([])).values).toEqual([]);
  });

  it('samples the share of casts the parse put on the wrong side of a buff', () => {
    const insideDance: CastOutsideBuffCondition = {
      kind: 'cast_outside_buff', spell_id: SECRET_TECHNIQUE, spell_name: 'Secret Technique',
      buff_spell_id: SHADOW_DANCE, buff_spell_name: 'Shadow Dance', require: 'inside',
    };
    const ctx = ruleCtx([cast(SECRET_TECHNIQUE, DANCE_START_S + 2), cast(SECRET_TECHNIQUE, DANCE_END_S + 5)],
      { buffs: buffWindow(SHADOW_DANCE, DANCE_START_S, DANCE_END_S) });
    const HALF_OFF_SIDE = 0.5;
    expect(sampleRule(insideDance, ctx).values).toEqual([HALF_OFF_SIDE]);
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

describe('unanimous field', () => {
  it('produces no finding for a player exactly on a unanimous field, one for a step off it, and reads the copy as a single number', () => {
    const blackPowder: CastAtTargetCountCondition = {
      kind: 'cast_at_target_count', spell_id: BLACK_POWDER, spell_name: 'Black Powder', bound: 'min',
    };
    const unanimous = band(5);
    const onIt = ruleCtx([cast(BLACK_POWDER, 10)], { damage: [1, 2, 3, 4, 5].map(id => damage(BLACK_POWDER, 11, 100, { target: id })) });
    const oneOff = ruleCtx([cast(BLACK_POWDER, 10)], { damage: [1, 2, 3, 4].map(id => damage(BLACK_POWDER, 11, 100, { target: id })) });
    expect(evaluateCastAtTargetCount(blackPowder, onIt, unanimous, 'warning')).toBeNull();
    const finding = evaluateCastAtTargetCount(blackPowder, oneOff, unanimous, 'warning');
    expect(finding?.message).toBe('1 of 1 Black Powder casts hit fewer than 5 targets. Wait for 5 or more.');
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

describe('occurrence strips', () => {
  it('cast_without_prior: a chip per judged cast, its lead as the label', () => {
    const ctx = ruleCtx([cast(SHADOW_DANCE, 10), cast(SECRET_TECHNIQUE, 12), cast(SECRET_TECHNIQUE, 40)]);
    const finding = evaluateCastWithoutPrior(SECRET_TECH_NEEDS_DANCE, ctx, band(PAIR_WINDOW_S), 'warning');
    expect(finding?.occurrences).toEqual([
      { atS: 12, ok: true, label: '2s', detail: 'Shadow Dance landed 2s from this cast.' },
      { atS: 40, ok: false, label: '30s', detail: 'Shadow Dance landed 30s from this cast.' },
    ]);
    expect(finding?.occurrenceTarget).toBe('within 5s of Shadow Dance');
  });

  it('hold_cooldown_for_anchor: marks the anchor cast and reads each charge\'s gap to it', () => {
    const ctx = ruleCtx([cast(SHADOW_BLADES, 10), cast(SHADOW_BLADES, 120), cast(SHADOW_DANCE, 110)]);
    const finding = evaluateHoldForAnchor(HOLD_DANCE_FOR_BLADES, ctx, band(HOLD_WINDOW_S), 'critical');
    expect(finding?.occurrences).toEqual([
      { atS: 110, ok: false, label: '10s', detail: 'Shadow Dance cast 10s before Shadow Blades.' },
      { atS: 120, ok: true, label: 'Shadow Blades', marker: true, detail: 'Shadow Blades cast here.' },
    ]);
    expect(finding?.occurrenceTarget).toBe('saved when Shadow Blades is within 15s');
  });

  it('cast_without_prior: the chip and the window limit both read one decimal, so a lead just past it reads visibly larger', () => {
    const WINDOW_LIMIT_S = 12;
    const OVER_LIMIT_LEAD_S = 12.4;
    const ctx = ruleCtx([cast(SHADOW_DANCE, 0), cast(SECRET_TECHNIQUE, WINDOW_LIMIT_S), cast(SECRET_TECHNIQUE, OVER_LIMIT_LEAD_S)]);
    const finding = evaluateCastWithoutPrior(SECRET_TECH_NEEDS_DANCE, ctx, band(WINDOW_LIMIT_S), 'warning');
    expect(finding?.measured).toEqual({ value: '1 / 2', unit: 'cast(s)' });
    expect(finding?.message).toBe('1 of 2 Secret Technique casts had no Shadow Dance before them. Cast it within 12s of Shadow Dance.');
    expect(finding?.occurrenceTarget).toBe('within 12s of Shadow Dance');
    expect(finding?.occurrences).toEqual([
      { atS: WINDOW_LIMIT_S, ok: true, label: '12s', detail: 'Shadow Dance landed 12s from this cast.' },
      { atS: OVER_LIMIT_LEAD_S, ok: false, label: '12.4s', detail: 'Shadow Dance landed 12.4s from this cast.' },
    ]);
  });

  it('hold_cooldown_for_anchor: the chip and the window limit both read one decimal, so a violation gap reads visibly smaller than the limit', () => {
    const HOLD_LIMIT_S = 12;
    const ANCHOR_S = 100;
    const CLEARED_GAP_S = 12.4;
    const VIOLATION_GAP_S = 11.6;
    const ctx = ruleCtx([
      cast(SHADOW_BLADES, 10), cast(SHADOW_BLADES, ANCHOR_S),
      cast(SHADOW_DANCE, ANCHOR_S - CLEARED_GAP_S), cast(SHADOW_DANCE, ANCHOR_S - VIOLATION_GAP_S),
    ]);
    const finding = evaluateHoldForAnchor(HOLD_DANCE_FOR_BLADES, ctx, band(HOLD_LIMIT_S, HOLD_LIMIT_S + 5), 'critical');
    expect(finding?.measured).toEqual({ value: '1 / 2', unit: 'charge(s)' });
    expect(finding?.message).toBe('Shadow Dance was used right before Shadow Blades 1 of 2 times. Save it when Shadow Blades is within 12s.');
    expect(finding?.occurrences).toEqual([
      { atS: ANCHOR_S - CLEARED_GAP_S, ok: true, label: '12.4s', detail: 'Shadow Dance cast 12.4s before Shadow Blades.' },
      { atS: ANCHOR_S - VIOLATION_GAP_S, ok: false, label: '11.6s', detail: 'Shadow Dance cast 11.6s before Shadow Blades.' },
      { atS: ANCHOR_S, ok: true, label: 'Shadow Blades', marker: true, detail: 'Shadow Blades cast here.' },
    ]);
  });

  it('hold_cooldown_for_anchor: a gap that clears the window is ok, and the low edge itself is strict', () => {
    const HOLD_LIMIT_S = 12;
    const ANCHOR_S = 100;
    const CLEARED_GAP_S = 12.4;
    const AT_LIMIT_GAP_S = 12;
    const UNDER_LIMIT_GAP_S = 11.6;
    // hi well above the cleared gap, so a compliant hold does not itself trip the far side.
    const field = band(HOLD_LIMIT_S, HOLD_LIMIT_S + 5);
    const held = (gapS: number) =>
      ruleCtx([cast(SHADOW_BLADES, 10), cast(SHADOW_BLADES, ANCHOR_S), cast(SHADOW_DANCE, ANCHOR_S - gapS)]);
    expect(evaluateHoldForAnchor(HOLD_DANCE_FOR_BLADES, held(CLEARED_GAP_S), field, 'critical')).toBeNull();
    expect(evaluateHoldForAnchor(HOLD_DANCE_FOR_BLADES, held(AT_LIMIT_GAP_S), field, 'critical')).toBeNull();
    expect(evaluateHoldForAnchor(HOLD_DANCE_FOR_BLADES, held(UNDER_LIMIT_GAP_S), field, 'critical')).not.toBeNull();
  });

  it('cast_outside_buff: a chip per cast, the buff state as the label', () => {
    const outsideDance: CastOutsideBuffCondition = {
      kind: 'cast_outside_buff', spell_id: SECRET_TECHNIQUE, spell_name: 'Secret Technique',
      buff_spell_id: SHADOW_DANCE, buff_spell_name: 'Shadow Dance', require: 'inside',
    };
    const ctx = ruleCtx([cast(SECRET_TECHNIQUE, 22), cast(SECRET_TECHNIQUE, 35)], { buffs: buffWindow(SHADOW_DANCE, 20, 28) });
    const finding = evaluateCastOutsideBuff(outsideDance, ctx, FIELD_NEVER, 'warning');
    expect(finding?.occurrences).toEqual([
      { atS: 22, ok: true, label: 'up', detail: 'Shadow Dance was up at this cast.' },
      { atS: 35, ok: false, label: 'down', detail: 'Shadow Dance was down at this cast.' },
    ]);
    expect(finding?.occurrenceTarget).toBe('Shadow Dance up every cast');
  });

  it('aura_uptime_below: a timeline of merged up-spans, plus a chip for each of the largest gaps', () => {
    const uptime: AuraUptimeBelowCondition = {
      kind: 'aura_uptime_below', aura_spell_id: RUPTURE, aura_spell_name: 'Rupture', on: 'target',
    };
    // Up 0-50s and 70-90s over a 120s fight: two gaps, 20s and 30s.
    const debuffs = [
      applyDebuff(RUPTURE, 0), removeDebuff(RUPTURE, 50),
      applyDebuff(RUPTURE, 70), removeDebuff(RUPTURE, 90),
    ];
    const ctx = ruleCtx([], { debuffs });
    const RUPTURE_MIN_PCT = 80;
    const finding = evaluateAuraUptimeBelow(uptime, ctx, band(RUPTURE_MIN_PCT), 'warning');
    expect(finding?.measured).toEqual({ value: '58 / 80', unit: '% uptime' });
    expect(finding?.timeline).toEqual({ segmentsS: [[0, 50], [70, 90]], fightDurationS: 120 });
    expect(finding?.occurrences).toEqual([
      { atS: 50, ok: false, label: '20s', detail: 'Rupture was down here for 20s.' },
      { atS: 90, ok: false, label: '30s', detail: 'Rupture was down here for 30s.' },
    ]);
  });

  it('aura_uptime_below: drops a sub-second gap from the chip strip, since it would render as a nonsensical "0s"', () => {
    const uptime: AuraUptimeBelowCondition = {
      kind: 'aura_uptime_below', aura_spell_id: RUPTURE, aura_spell_name: 'Rupture', on: 'target',
    };
    const FIGHT_END_S = 20;
    // Up 0.3-10s and 15-20s over a 20s fight: a 0.3s opening gap (travel-time noise, not a maintain miss) plus a real 5s gap.
    const debuffs = [applyDebuff(RUPTURE, 0.3), removeDebuff(RUPTURE, 10), applyDebuff(RUPTURE, 15)];
    const ctx = ruleCtx([], { debuffs, fightDurationS: FIGHT_END_S });
    const finding = evaluateAuraUptimeBelow(uptime, ctx, band(90), 'warning');
    expect(finding?.timeline).toEqual({ segmentsS: [[0.3, 10], [15, 20]], fightDurationS: FIGHT_END_S });
    expect(finding?.occurrences).toEqual([
      { atS: 10, ok: false, label: '5s', detail: 'Rupture was down here for 5s.' },
    ]);
  });

  it('aura_uptime_below: draws the timeline against the full fight, so a dead stretch still reads as a downtime gap', () => {
    const uptime: AuraUptimeBelowCondition = {
      kind: 'aura_uptime_below', aura_spell_id: RUPTURE, aura_spell_name: 'Rupture', on: 'target',
    };
    // Up 0-40s and 90-120s of the 120s fight: one 50s gap.
    const debuffs = [applyDebuff(RUPTURE, 0), removeDebuff(RUPTURE, 40), applyDebuff(RUPTURE, 90)];
    const ctx = ruleCtx([], { debuffs });
    const finding = evaluateAuraUptimeBelow(uptime, ctx, band(90), 'warning');
    expect(finding?.timeline).toEqual({ segmentsS: [[0, 40], [90, 120]], fightDurationS: RULE_FIGHT_END_S });
    expect(finding?.occurrences).toEqual([
      { atS: 40, ok: false, label: '50s', detail: 'Rupture was down here for 50s.' },
    ]);
  });

  it('opening_sequence: a chip per authored step, a missed one carrying a "not reached" note instead of a time', () => {
    const opener: OpeningSequenceCondition = {
      kind: 'opening_sequence',
      spell_ids: [SHADOW_BLADES, SHADOW_DANCE, SECRET_TECHNIQUE],
      spell_names: ['Shadow Blades', 'Shadow Dance', 'Secret Technique'],
    };
    const ctx = ruleCtx([cast(SHADOW_BLADES, 1), cast(SECRET_TECHNIQUE, 3)]);
    const OPENER_WINDOW_S = 12;
    const finding = evaluateOpeningSequence(opener, ctx, band(OPENER_WINDOW_S), 'warning');
    expect(finding?.occurrences).toEqual([
      { atS: 1, ok: true, label: 'Shadow Blades', detail: 'Shadow Blades landed on time in its slot.' },
      { ok: false, label: 'Shadow Dance', note: 'not reached', detail: 'Shadow Dance was never reached in the opener window.' },
      { atS: 3, ok: true, label: 'Secret Technique', detail: 'Secret Technique landed on time in its slot.' },
    ]);
    expect(finding?.occurrenceTarget).toBe('expected order: Shadow Blades > Shadow Dance > Secret Technique');
  });

  it('cast_at_target_count: a chip per cast, the target count as the label', () => {
    const blackPowder: CastAtTargetCountCondition = {
      kind: 'cast_at_target_count', spell_id: BLACK_POWDER, spell_name: 'Black Powder', bound: 'min',
    };
    const ctx = ruleCtx([cast(BLACK_POWDER, 10), cast(BLACK_POWDER, 30)], {
      damage: [
        ...[1, 2].map(id => damage(BLACK_POWDER, 11, 100, { target: id })),
        ...[1, 2, 3].map(id => damage(BLACK_POWDER, 31, 100, { target: id })),
      ],
    });
    const finding = evaluateCastAtTargetCount(blackPowder, ctx, band(3), 'warning');
    expect(finding?.occurrences).toEqual([
      { atS: 10, ok: false, label: '2', detail: 'Black Powder cast at 2.' },
      { atS: 30, ok: true, label: '3', detail: 'Black Powder cast at 3.' },
    ]);
    expect(finding?.occurrenceTarget).toBe('Wait for 3 or more.');
  });

  it('resource_at_cast: a chip per cast, the raw amount over its own cap as the label (a small pool reads as a count, not a percent)', () => {
    const finisher: ResourceAtCastCondition = {
      kind: 'resource_at_cast', spell_id: EVISCERATE, spell_name: 'Eviscerate',
      resource_type: COMBO_POINT_TYPE, resource_name: 'combo points', bound: 'min',
    };
    const atCombo = (atS: number, amount: number) =>
      cast(EVISCERATE, atS, { resources: [{ amount, max: MAX_COMBO_POINTS, type: COMBO_POINT_TYPE }] });
    const ctx = ruleCtx([atCombo(10, 3), atCombo(20, MAX_COMBO_POINTS)]);
    const finding = evaluateResourceAtCast(finisher, ctx, band(1), 'warning');
    expect(finding?.occurrences).toEqual([
      { atS: 10, ok: false, label: '3/5', detail: 'Eviscerate cast at 3/5.' },
      { atS: 20, ok: true, label: '5/5', detail: 'Eviscerate cast at 5/5.' },
    ]);
    expect(finding?.occurrenceTarget).toBe('Spend at 5/5 or more.');
  });

  it('resource_at_cast: a large pool (mana) still reads as a percent, since WCL reports it as a five/six-digit number', () => {
    const innervate: ResourceAtCastCondition = {
      kind: 'resource_at_cast', spell_id: EVISCERATE, spell_name: 'Innervate',
      resource_type: COMBO_POINT_TYPE, resource_name: 'mana', bound: 'min',
    };
    const MANA_MAX = 250_000;
    const atMana = (atS: number, amount: number) =>
      cast(EVISCERATE, atS, { resources: [{ amount, max: MANA_MAX, type: COMBO_POINT_TYPE }] });
    const ctx = ruleCtx([atMana(10, MANA_MAX * 0.6), atMana(20, MANA_MAX)]);
    const finding = evaluateResourceAtCast(innervate, ctx, band(1), 'warning');
    expect(finding?.occurrences).toEqual([
      { atS: 10, ok: false, label: '60%', detail: 'Innervate cast at 60%.' },
      { atS: 20, ok: true, label: '100%', detail: 'Innervate cast at 100%.' },
    ]);
    expect(finding?.occurrenceTarget).toBe('Spend at 100% or more.');
  });

  it('proc_wasted: a chip per proc span, used vs wasted as the label', () => {
    const spendDance: ProcWastedCondition = {
      kind: 'proc_wasted', buff_spell_id: SHADOW_DANCE, buff_spell_name: 'Shadow Dance',
      spend_spell_ids: [SECRET_TECHNIQUE], spend_spell_names: ['Secret Technique'],
    };
    const buffs = [...buffWindow(SHADOW_DANCE, 20, 28), ...buffWindow(SHADOW_DANCE, 40, 50)];
    const ctx = ruleCtx([cast(SECRET_TECHNIQUE, 22)], { buffs });
    const finding = evaluateProcWasted(spendDance, ctx, FIELD_NEVER, 'warning');
    expect(finding?.occurrences).toEqual([
      { atS: 20, ok: true, label: 'used', detail: 'Shadow Dance was spent before it expired.' },
      { atS: 40, ok: false, label: 'wasted', detail: 'Shadow Dance expired unspent here.' },
    ]);
    expect(finding?.occurrenceTarget).toBe('spent every time');
  });

  it('filler_in_buff: a chip per filler cast inside the buff, coached vs alternative as the label', () => {
    const wrathInSolar: FillerInBuffCondition = {
      kind: 'filler_in_buff',
      spell_id: WRATH, spell_name: 'Wrath',
      alternative_spell_ids: [STARFIRE], alternative_spell_names: ['Starfire'],
      buff_spell_id: ECLIPSE_SOLAR, buff_spell_name: 'Eclipse (Solar)',
    };
    const ctx = ruleCtx([cast(WRATH, 12), cast(STARFIRE, 14), cast(STARFIRE, 20)], { buffs: buffWindow(ECLIPSE_SOLAR, 10, 40) });
    const finding = evaluateFillerInBuff(wrathInSolar, ctx, band(0.9, 1), 'warning');
    expect(finding?.occurrences).toEqual([
      { atS: 12, ok: true, label: 'Wrath', detail: 'Wrath was the coached filler here.' },
      { atS: 14, ok: false, label: 'Starfire', detail: 'Starfire was pressed instead of Wrath here.' },
      { atS: 20, ok: false, label: 'Starfire', detail: 'Starfire was pressed instead of Wrath here.' },
    ]);
    expect(finding?.occurrenceTarget).toBe('90% or more Wrath during Eclipse (Solar)');
  });

  it('spend_at_stacks: a chip per cast, the count against the cap as the label', () => {
    const spendAtStacks: SpendAtStacksCondition = {
      kind: 'spend_at_stacks',
      spell_id: LIGHTNING_BOLT, spell_name: 'Lightning Bolt',
      buff_spell_id: MAELSTROM_WEAPON, buff_spell_name: 'Maelstrom Weapon',
      bound: 'min', max_stacks: 10,
    };
    const buffs = [applyBuff(MAELSTROM_WEAPON, 1), applyBuffStack(MAELSTROM_WEAPON, 5, 5), applyBuffStack(MAELSTROM_WEAPON, 9, 9)];
    const ctx = ruleCtx([cast(LIGHTNING_BOLT, 6), cast(LIGHTNING_BOLT, 10)], { buffs });
    // hi at 9 (not the degenerate 8-8) so the second cast, one above the floor, does not itself trip the far side.
    const finding = evaluateSpendAtStacks(spendAtStacks, ctx, band(8, 9), 'warning');
    expect(finding?.occurrences).toEqual([
      { atS: 6, ok: false, label: '5/10', detail: 'Lightning Bolt cast at 5/10.' },
      { atS: 10, ok: true, label: '9/10', detail: 'Lightning Bolt cast at 9/10.' },
    ]);
    expect(finding?.occurrenceTarget).toBe('Spend at 8/10 or more.');
    expect(finding?.message).toBe('1 of 2 Lightning Bolt casts were spent under 8/10 stacks of Maelstrom Weapon. Spend at 8/10 or more.');
  });

  it('aura_clipped: a chip per hard-cast refresh, the elapsed time as the label', () => {
    const moonfireClipped: AuraClippedCondition = {
      kind: 'aura_clipped',
      aura_spell_id: MOONFIRE_DOT, aura_spell_name: 'Moonfire',
      cast_spell_id: MOONFIRE, cast_spell_name: 'Moonfire', on: 'target',
    };
    const debuffs = [applyDebuff(MOONFIRE_DOT, 20), refreshDebuff(MOONFIRE_DOT, 24), refreshDebuff(MOONFIRE_DOT, 36)];
    const ctx = ruleCtx([cast(MOONFIRE, 24), cast(MOONFIRE, 36)], { debuffs });
    const finding = evaluateAuraClipped(moonfireClipped, ctx, band(10, 12), 'warning');
    expect(finding?.occurrences).toEqual([
      { atS: 24, ok: false, label: '4s', detail: 'Refreshed 4s into the aura.' },
      { atS: 36, ok: true, label: '12s', detail: 'Refreshed 12s into the aura.' },
    ]);
    expect(finding?.occurrenceTarget).toBe('let it run at least 10s');
  });

  it('filler_below_health: a chip per filler cast under the health gate, coached vs alternative as the label', () => {
    const executeBelow: FillerBelowHealthCondition = {
      kind: 'filler_below_health',
      spell_id: EXECUTE, spell_name: 'Execute',
      alternative_spell_ids: [SLAM], alternative_spell_names: ['Slam'],
      health_pct: 20,
    };
    const HIT_S = 100;
    const hitAt = (atS: number, healthPct: number) => damage(SHADOW_BLADES_DAMAGE, atS, 1, { targetHealthPct: healthPct });
    const ctx = ruleCtx([cast(EXECUTE, HIT_S + 0.5), cast(SLAM, HIT_S + 1)], { damage: [hitAt(HIT_S, 15)] });
    const finding = evaluateFillerBelowHealth(executeBelow, ctx, band(0.95, 1), 'warning');
    expect(finding?.occurrences).toEqual([
      { atS: 100.5, ok: true, label: 'Execute', detail: 'Execute was the coached filler here.' },
      { atS: 101, ok: false, label: 'Slam', detail: 'Slam was pressed instead of Execute here.' },
    ]);
    expect(finding?.occurrenceTarget).toBe('95% or more Execute under 20% health');
  });

  it('caps a finding at MAX_OCCURRENCES, keeping chronological order', () => {
    const OVER_CAP_CASTS = 30;
    const blackPowder: CastAtTargetCountCondition = {
      kind: 'cast_at_target_count', spell_id: BLACK_POWDER, spell_name: 'Black Powder', bound: 'min',
    };
    const casts = Array.from({ length: OVER_CAP_CASTS }, (_, i) => cast(BLACK_POWDER, i + 1));
    const dmg = Array.from({ length: OVER_CAP_CASTS }, (_, i) => damage(BLACK_POWDER, i + 1.5, 100, { target: 1 }));
    const finding = evaluateCastAtTargetCount(blackPowder, ruleCtx(casts, { damage: dmg }), band(3), 'warning');
    const occurrences = finding!.occurrences!;
    expect(occurrences.length).toBe(24);
    expect(occurrences[0].atS).toBe(1);
    const timestamps = occurrences.map(o => o.atS);
    expect(timestamps).toEqual([...timestamps].sort((a, b) => (a ?? 0) - (b ?? 0)));
  });

  it('never drops a violation from the sampled strip, even when passing casts alone exceed the cap', () => {
    const finisher: ResourceAtCastCondition = {
      kind: 'resource_at_cast', spell_id: EVISCERATE, spell_name: 'Eviscerate',
      resource_type: COMBO_POINT_TYPE, resource_name: 'combo points', bound: 'min',
    };
    const atCombo = (atS: number, amount: number) =>
      cast(EVISCERATE, atS, { resources: [{ amount, max: MAX_COMBO_POINTS, type: COMBO_POINT_TYPE }] });
    const FAIL_AT_S = [5, 15, 25];
    const fails = FAIL_AT_S.map(atS => atCombo(atS, 1));
    const PASSING_CASTS = 30; // clears MAX_OCCURRENCES (24) so sampling kicks in
    const passes = Array.from({ length: PASSING_CASTS }, (_, i) => atCombo(100 + i, MAX_COMBO_POINTS));
    const finding = evaluateResourceAtCast(finisher, ruleCtx([...fails, ...passes]), band(1), 'warning');
    const occurrences = finding!.occurrences!;
    expect(occurrences.length).toBe(24);
    const failingAtS = occurrences.filter(occ => !occ.ok).map(occ => occ.atS);
    expect(failingAtS).toEqual(FAIL_AT_S);
  });
});
