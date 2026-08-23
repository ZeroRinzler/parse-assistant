import { Injectable } from '@angular/core';
import { AnalysisFinding } from '../../../../../../domain/analysis/analysis.models';
import { CastAtTargetCountCondition, RuleSeverity } from '../../../../../../domain/rulebook/rulebook.models';
import { DamageRow, RuleContext } from '../rule-context-service';
import { RuleBand, RuleDomain, RuleJudging, RuleStream } from '../rule-kind';
import { BoundedPerCastKind } from '../bounded-per-cast-kind';

/** Enemies damaged this soon after a cast count as engaged for it; an AoE ability lands well inside a GCD or two. */
const TARGET_COUNT_WINDOW_S = 3;

@Injectable({ providedIn: 'root' })
export class CastAtTargetCountKind extends BoundedPerCastKind<CastAtTargetCountCondition> {
  readonly kind = 'cast_at_target_count';

  streams(): RuleStream[] {
    return ['damage'];
  }

  readonly pooling = 'instance';

  judging(cond: CastAtTargetCountCondition): RuleJudging {
    return { primary: cond.bound === 'min' ? 'below' : 'above', twoSided: false };
  }

  domain(): RuleDomain | null {
    return { min: 1, max: null, step: 1 };
  }

  sample(cond: CastAtTargetCountCondition, ctx: RuleContext): number[] {
    return this.targetCountsPerCast(cond, ctx).map(entry => entry.targets);
  }

  applicable(cond: CastAtTargetCountCondition, ctx: RuleContext): boolean {
    return this.targetCountsPerCast(cond, ctx).length > 0;
  }

  label(cond: CastAtTargetCountCondition): string {
    return `${cond.spell_name} target count`;
  }

  /** Every enemy the player was damaging, since both bounds ask how many were up to be hit, not how many this ability struck. */
  private targetsAtCast(damage: readonly DamageRow[], castTimeS: number): number {
    const fromS = castTimeS;
    const toS = fromS + TARGET_COUNT_WINDOW_S;
    const targets = new Set<string>();
    for (const [atS, target] of damage) {
      if (atS > toS) break;
      if (atS >= fromS) targets.add(target);
    }
    return targets.size;
  }

  private targetCountsPerCast(cond: CastAtTargetCountCondition, ctx: RuleContext): { timeS: number; targets: number }[] {
    return [...(ctx.castTimes[cond.spell_id] ?? [])].sort((a, b) => a - b)
      .map(timeS => ({ timeS, targets: this.targetsAtCast(ctx.damageIndex(), timeS) }))
      .filter(({ targets }) => targets > 0);
  }

  protected evaluateBanded(
    cond: CastAtTargetCountCondition, ctx: RuleContext, band: RuleBand, judging: RuleJudging, severity: RuleSeverity, remedy?: string,
  ): AnalysisFinding | null {
    return this.evaluateBoundedPerCast({
      values: this.targetCountsPerCast(cond, ctx).map(({ timeS, targets }) => ({ timeS, value: targets })),
      scale: this.WHOLE_STEPS,
      subject: cond.spell_name,
      label: limit => `at ${cond.bound === 'min' ? 'under' : 'over'} ${limit} targets`,
      phrase: limit => cond.bound === 'min' ? `hit fewer than ${limit} targets` : `hit more than ${limit} targets`,
      advice: limit => cond.bound === 'min' ? `Wait for ${limit} or more.` : `Use it on ${limit} or fewer.`,
    }, band, judging, severity, remedy);
  }
}
