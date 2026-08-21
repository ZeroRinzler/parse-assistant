import {
  RulebookRule, RuleCondition, RuleSeverity, CastWithoutPriorCondition, HoldCooldownForAnchorCondition,
} from '../../../../core/models/rulebook.models';
import { WclEvent } from '../../../../core/models/wcl.models';
import { AnalysisFinding } from '../../../../core/models/analysis.models';
import { withRelativeS } from '../../../../shared/analysis/wcl-projections';
import { BenchedRule, RuleBand, RuleJudging } from './engine-core';
import { RuleContext, buildRuleContext } from './rule-context';
import { ruleJudging } from './engine';
import { SHADOW_BLADES, SHADOW_DANCE, SECRET_TECHNIQUE } from '../../../../../testing/spell-ids';

/** Each evaluator is called with the judging its own kind declares, so a spec can never assert against a side the table does not use. */
export function judged<C extends RuleCondition>(
  evaluate: (c: C, ctx: RuleContext, band: RuleBand, judging: RuleJudging, severity: RuleSeverity, remedy?: string) => AnalysisFinding | null,
) {
  return (c: C, ctx: RuleContext, band: RuleBand, severity: RuleSeverity, remedy?: string) =>
    evaluate(c, ctx, band, ruleJudging(c), severity, remedy);
}

// Zero tolerance keeps the fixture arithmetic exact; hi defaults to lo for the one-sided kinds this factory feeds most often.
export const PAIR_WINDOW_S = 5, HOLD_WINDOW_S = 15;
export function band(lo: number, hi = lo, tolerance = 0): RuleBand {
  return { lo, hi, tolerance };
}

// The share kinds judge a violation share against [lo, hi]; a field that never breaks the rule flags any nonzero share.
export const FIELD_NEVER = band(0);

export function ruleFor(condition: RuleCondition, over: Partial<RulebookRule> = {}): RulebookRule {
  return { type: 'rotation', severity: 'warning', description: 'authored rule', action: 'authored fix', condition, ...over };
}

// A rule whose band this encounter measured, so fixtures about something else are not gated on it.
export function benched(rule: RulebookRule, ruleBandValue: RuleBand | null = band(PAIR_WINDOW_S)): BenchedRule {
  return { rule, band: ruleBandValue, sample_count: ruleBandValue == null ? 0 : 10 };
}

// Build a RuleContext for a 0..120s fight from just the casts - keeps the rule call sites terse.
export const RULE_FIGHT_END_S = 120;
interface RuleCtxOverrides { buffs: WclEvent[]; debuffs: WclEvent[]; damage: WclEvent[]; fightDurationS: number }
export function ruleCtx(casts: WclEvent[], over: Partial<RuleCtxOverrides> = {}): RuleContext {
  return buildRuleContext({
    casts: withRelativeS(casts, 0),
    buffs: withRelativeS(over.buffs ?? [], 0),
    debuffs: withRelativeS(over.debuffs ?? [], 0),
    damage: withRelativeS(over.damage ?? [], 0),
    fightDurationS: over.fightDurationS ?? RULE_FIGHT_END_S,
  });
}

// Two real Subtlety rules reused across the evaluator and rules-followed specs.
export const SECRET_TECH_NEEDS_DANCE: CastWithoutPriorCondition = {
  kind: 'cast_without_prior',
  spell_id: SECRET_TECHNIQUE, spell_name: 'Secret Technique',
  required_spell_id: SHADOW_DANCE, required_spell_name: 'Shadow Dance',
};
export const HOLD_DANCE_FOR_BLADES: HoldCooldownForAnchorCondition = {
  kind: 'hold_cooldown_for_anchor',
  spell_ids: [SHADOW_DANCE], spell_names: ['Shadow Dance'],
  anchor_spell_id: SHADOW_BLADES, anchor_spell_name: 'Shadow Blades',
};

// Fight-relative seconds shared by the new-kind fixtures.
export const DANCE_START_S = 20, DANCE_END_S = 28;
export const COMBO_POINT_TYPE = 4;  // WCL power-type id for combo points
export const MAX_COMBO_POINTS = 5;
