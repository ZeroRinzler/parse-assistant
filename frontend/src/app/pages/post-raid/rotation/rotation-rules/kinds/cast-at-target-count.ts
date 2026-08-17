import { AnalysisFinding } from '../../../../../core/models/analysis.models';
import { CastAtTargetCountCondition } from '../../../../../core/models/rulebook.models';
import { DamageRow, RuleContext } from '../rule-context';
import { KindSpec, RuleBand, RuleJudging, Severity, WHOLE_STEPS, withBand } from '../engine-core';
import { evaluateBoundedPerCast } from '../bounded-per-cast';

/** Enemies damaged this soon after a cast count as engaged for it; an AoE ability lands well inside a GCD or two. */
const TARGET_COUNT_WINDOW_S = 3;

/** Every enemy the player was damaging, since both bounds ask how many were up to be hit, not how many this ability struck. */
function targetsAtCast(damage: readonly DamageRow[], castTimeS: number): number {
  const fromS = castTimeS;
  const toS = fromS + TARGET_COUNT_WINDOW_S;
  const targets = new Set<string>();
  for (const [atS, target] of damage) {
    if (atS > toS) break;
    if (atS >= fromS) targets.add(target);
  }
  return targets.size;
}

function targetCountsPerCast(cond: CastAtTargetCountCondition, ctx: RuleContext): { timeS: number; targets: number }[] {
  return [...(ctx.castTimes[cond.spell_id] ?? [])].sort((a, b) => a - b)
    .map(timeS => ({ timeS, targets: targetsAtCast(ctx.damageIndex(), timeS) }))
    .filter(({ targets }) => targets > 0);
}

export function evaluateCastAtTargetCount(
  cond: CastAtTargetCountCondition, ctx: RuleContext, band: RuleBand, judging: RuleJudging, severity: Severity, remedy?: string,
): AnalysisFinding | null {
  return evaluateBoundedPerCast({
    values: targetCountsPerCast(cond, ctx).map(({ timeS, targets }) => ({ timeS, value: targets })),
    scale: WHOLE_STEPS,
    subject: cond.spell_name,
    label: limit => `at ${cond.bound === 'min' ? 'under' : 'over'} ${limit} targets`,
    phrase: limit => cond.bound === 'min' ? `hit fewer than ${limit} targets` : `hit more than ${limit} targets`,
    advice: limit => cond.bound === 'min' ? `Wait for ${limit} or more.` : `Use it on ${limit} or fewer.`,
  }, band, judging, severity, remedy);
}

export const CAST_AT_TARGET_COUNT_KIND: KindSpec<CastAtTargetCountCondition> = {
  streams: () => ['damage'],
  pooling: 'instance',
  judging: cond => ({ primary: cond.bound === 'min' ? 'below' : 'above', twoSided: false }),
  domain: () => ({ min: 1, max: null, step: 1 }),
  sample: (cond, ctx) => targetCountsPerCast(cond, ctx).map(entry => entry.targets),
  evaluate: withBand(evaluateCastAtTargetCount),
  applicable: (cond, ctx) => targetCountsPerCast(cond, ctx).length > 0,
  label: cond => `${cond.spell_name} target count`,
};
