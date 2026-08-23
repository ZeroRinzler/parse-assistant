import { Injectable } from '@angular/core';
import { AnalysisFinding } from '../../../../../../domain/analysis/analysis.models';
import { SpendAtStacksCondition, RuleSeverity } from '../../../../../../domain/rulebook/rulebook.models';
import { RuleContext } from '../rule-context-service';
import { RuleBand, RuleDomain, RuleJudging, RuleStream, Scale } from '../rule-kind';
import { BoundedPerCastKind } from '../bounded-per-cast-kind';

@Injectable({ providedIn: 'root' })
export class SpendAtStacksKind extends BoundedPerCastKind<SpendAtStacksCondition> {
  readonly kind = 'spend_at_stacks';

  streams(): RuleStream[] {
    return [];
  }

  readonly pooling = 'instance';

  // Spending above a floor has a live far side: sitting at the cap wastes generation. A ceiling rule has none - spending at zero stacks costs nothing.

  judging(cond: SpendAtStacksCondition): RuleJudging {
    return { primary: cond.bound === 'min' ? 'below' : 'above', twoSided: cond.bound === 'min' };
  }

  domain(cond: SpendAtStacksCondition): RuleDomain | null {
    return cond.max_stacks == null ? null : { min: 0, max: cond.max_stacks, step: 1 };
  }

  sample(cond: SpendAtStacksCondition, ctx: RuleContext): number[] {
    return this.stackCountsPerCast(cond, ctx).map(entry => entry.stacks);
  }

  applicable(cond: SpendAtStacksCondition, ctx: RuleContext): boolean {
    return this.stackCountsPerCast(cond, ctx).length > 0;
  }

  label(cond: SpendAtStacksCondition): string {
    return `${cond.spell_name} at ${cond.buff_spell_name}`;
  }

  /** Drops a cast whose count falls before the buff's first recorded trace, rather than scoring an unknowable count as zero. */
  private stackCountsPerCast(cond: SpendAtStacksCondition, ctx: RuleContext): { timeS: number; stacks: number }[] {
    const timeline = ctx.stacks(cond.buff_spell_id);
    return [...(ctx.castTimes[cond.spell_id] ?? [])].sort((a, b) => a - b)
      .filter(timeS => !this.suspendedAt(cond.except_buff_spell_ids, ctx, timeS))
      .map(timeS => ({ timeS, stacks: this.auraWindows.stacksAt(timeline, timeS) }))
      .filter((entry): entry is { timeS: number; stacks: number } => entry.stacks !== null);
  }

  protected evaluateBanded(
    cond: SpendAtStacksCondition, ctx: RuleContext, band: RuleBand, judging: RuleJudging, severity: RuleSeverity, remedy?: string,
  ): AnalysisFinding | null {
    // No declared cap means no domain and no band, so the rule was already dropped; bail rather than judge on a guess.
    const maxStacks = cond.max_stacks;
    if (maxStacks == null) return null;
    // Over the bar is overcapping, which is what a player sees; under it is spending cheap.
    const wording = cond.bound === 'min' ? 'under' : 'over';
    // Keep WHOLE_STEPS's own rounding: rawCountScale's quantize multiplies by max, which is only valid for a fractional threshold, not this measure's raw stack count.
    const capScale = this.rawCountScale(maxStacks);
    const scale: Scale = { quantize: this.WHOLE_STEPS.quantize, format: capScale.format, span: capScale.span };
    return this.evaluateBoundedPerCast({
      values: this.stackCountsPerCast(cond, ctx).map(({ timeS, stacks }) => ({ timeS, value: stacks })),
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
}
