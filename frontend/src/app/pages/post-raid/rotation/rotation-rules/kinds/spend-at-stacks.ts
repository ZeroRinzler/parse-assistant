import { AnalysisFinding } from '../../../../../core/models/analysis.models';
import { SpendAtStacksCondition, RuleSeverity } from '../../../../../core/models/rulebook.models';
import { stacksAt } from '../../../../../shared/analysis/aura-windows';
import { RuleContext, suspendedAt } from '../rule-context';
import {
  KindSpec, RuleBand, RuleJudging, Scale, WHOLE_STEPS, rawCountScale, withBand,
} from '../engine-core';
import { evaluateBoundedPerCast } from '../bounded-per-cast';

/** Drops a cast whose count falls before the buff's first recorded trace, rather than scoring an unknowable count as zero. */
function stackCountsPerCast(cond: SpendAtStacksCondition, ctx: RuleContext): { timeS: number; stacks: number }[] {
  const timeline = ctx.stacks(cond.buff_spell_id);
  return [...(ctx.castTimes[cond.spell_id] ?? [])].sort((a, b) => a - b)
    .filter(timeS => !suspendedAt(cond.except_buff_spell_ids, ctx, timeS))
    .map(timeS => ({ timeS, stacks: stacksAt(timeline, timeS) }))
    .filter((entry): entry is { timeS: number; stacks: number } => entry.stacks !== null);
}

export function evaluateSpendAtStacks(
  cond: SpendAtStacksCondition, ctx: RuleContext, band: RuleBand, judging: RuleJudging, severity: RuleSeverity, remedy?: string,
): AnalysisFinding | null {
  // No declared cap means no domain and no band, so the rule was already dropped; bail rather than judge on a guess.
  const maxStacks = cond.max_stacks;
  if (maxStacks == null) return null;
  // Over the bar is overcapping, which is what a player sees; under it is spending cheap.
  const wording = cond.bound === 'min' ? 'under' : 'over';
  // Keep WHOLE_STEPS's own rounding: rawCountScale's quantize multiplies by max, which is only valid for a fractional threshold, not this measure's raw stack count.
  const capScale = rawCountScale(maxStacks);
  const scale: Scale = { quantize: WHOLE_STEPS.quantize, format: capScale.format, span: capScale.span };
  return evaluateBoundedPerCast({
    values: stackCountsPerCast(cond, ctx).map(({ timeS, stacks }) => ({ timeS, value: stacks })),
    scale,
    subject: cond.spell_name,
    label: limit => `at ${wording} ${limit} ${cond.buff_spell_name}`,
    phrase: limit => `were spent ${wording} ${limit} stacks of ${cond.buff_spell_name}${cond.bound === 'max' ? ', overcapping' : ''}`,
    advice: limit => cond.bound === 'min' ? `Spend at ${limit} or more.` : `Spend at ${limit} or less.`,
    farLabel: limit => `past ${limit} ${cond.buff_spell_name}`,
    farPhrase: limit => `were held past ${limit} stacks of ${cond.buff_spell_name}`,
    farAdvice: 'Spend before you cap.',
  }, band, judging, severity, remedy);
}

export const SPEND_AT_STACKS_KIND: KindSpec<SpendAtStacksCondition> = {
  streams: () => [],
  pooling: 'instance',
  // Spending above a floor has a live far side: sitting at the cap wastes generation. A ceiling rule has none - spending at zero stacks costs nothing.
  judging: cond => ({ primary: cond.bound === 'min' ? 'below' : 'above', twoSided: cond.bound === 'min' }),
  domain: cond => cond.max_stacks == null ? null : { min: 0, max: cond.max_stacks, step: 1 },
  sample: (cond, ctx) => stackCountsPerCast(cond, ctx).map(entry => entry.stacks),
  evaluate: withBand(evaluateSpendAtStacks),
  applicable: (cond, ctx) => stackCountsPerCast(cond, ctx).length > 0,
  label: cond => `${cond.spell_name} at ${cond.buff_spell_name}`,
};
