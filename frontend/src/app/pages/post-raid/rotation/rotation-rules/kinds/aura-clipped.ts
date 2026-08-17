import { median } from 'd3-array';
import { round } from '../../../../../shared/analysis/analysis-math';
import { AnalysisFinding, FindingOccurrence } from '../../../../../core/models/analysis.models';
import { AuraClippedCondition } from '../../../../../core/models/rulebook.models';
import { AuraSpan, AuraSpansByTarget } from '../../../../../shared/analysis/aura-windows';
import { RuleContext, suspendedAt } from '../rule-context';
import {
  KindSpec, RuleBand, RuleJudging, SECONDS, Severity,
  bandLimits, exceedsTolerance, outOfBand, sampleOccurrences, withBand,
} from '../engine-core';

/** A re-application this soon AFTER a cast is that cast landing: measured deltas run 0-28ms, so this covers projectile flight without reaching the next proc. */
const HARD_CAST_WINDOW_S = 0.25;

type ClosedSpan = AuraSpan & { endS: number };

/** Narrows in one place, so the spans that ran to an end are handled without asserting on every read. */
function closedSpans(perTarget: AuraSpansByTarget): ClosedSpan[] {
  return [...perTarget.values()].flat().filter((span): span is ClosedSpan => span.endS != null);
}

function clipSpans(cond: AuraClippedCondition, ctx: RuleContext): AuraSpansByTarget {
  return cond.on === 'target' ? ctx.targetSpans(cond.aura_spell_id) : ctx.selfSpans(cond.aura_spell_id);
}

/** Only a re-application the player cast counts, since most refreshes in a log are procs rather than presses. */
function hardCastRefreshes(cond: AuraClippedCondition, ctx: RuleContext): ClosedSpan[] {
  const castTimes = ctx.castTimes[cond.cast_spell_id] ?? [];
  // One-sided: a cast after the refresh cannot have caused it.
  const cast = (atS: number) => castTimes.some(time => atS - time >= 0 && atS - time <= HARD_CAST_WINDOW_S);
  return closedSpans(clipSpans(cond, ctx))
    .filter(span => span.endedByRefresh && cast(span.endS)
      && !suspendedAt(cond.except_buff_spell_ids, ctx, span.endS));
}

/** Needs no authored duration, so neither a death-truncated span nor a pandemic-extended one can skew it. */
function elapsedAtRefresh(cond: AuraClippedCondition, ctx: RuleContext): { timeS: number; elapsedS: number }[] {
  return hardCastRefreshes(cond, ctx)
    .map(span => ({ timeS: span.endS, elapsedS: span.endS - span.startS }))
    .sort((a, b) => a.timeS - b.timeS);
}

export function evaluateAuraClipped(
  cond: AuraClippedCondition, ctx: RuleContext, band: RuleBand, judging: RuleJudging, severity: Severity, remedy?: string,
): AnalysisFinding | null {
  const { lo, hi } = bandLimits(SECONDS, band);
  const judged = elapsedAtRefresh(cond, ctx);
  if (!judged.length) return null;
  const clipped = judged.filter(({ elapsedS }) => outOfBand(elapsedS, lo, hi, judging));
  if (!exceedsTolerance(clipped.length, judged.length, band)) return null;
  const firstClipped = clipped[0];
  if (firstClipped == null) return null;
  const outValues = clipped.map(entry => entry.elapsedS);
  return {
    severity, category: 'rule_violation',
    timestamp_s: round(firstClipped.timeS, 3),
    label: `${cond.aura_spell_name} clipped`,
    message: `You refreshed ${cond.aura_spell_name} early ${clipped.length} of ${judged.length} times, on average ${SECONDS.format(median(outValues) ?? 0)} in. Let it run at least ${SECONDS.format(lo)}.`,
    measured: { value: `${clipped.length} / ${judged.length}`, unit: 'refresh(es)' },
    details: remedy ? { remedy } : undefined,
    occurrences: sampleOccurrences(judged.map(({ timeS, elapsedS }): FindingOccurrence => ({
      atS: round(timeS, 3), ok: !outOfBand(elapsedS, lo, hi, judging), label: SECONDS.format(elapsedS),
      detail: `Refreshed ${SECONDS.format(elapsedS)} into the aura.`,
    }))),
    occurrenceTarget: `let it run at least ${SECONDS.format(lo)}`,
  };
}

export const AURA_CLIPPED_KIND: KindSpec<AuraClippedCondition> = {
  streams: cond => cond.on === 'target' ? ['enemyAuras'] : [],
  pooling: 'instance',
  judging: () => ({ primary: 'below', twoSided: false }),
  domain: () => ({ min: 0, max: null }),
  sample: (cond, ctx) => elapsedAtRefresh(cond, ctx).map(entry => entry.elapsedS),
  evaluate: withBand(evaluateAuraClipped),
  applicable: (cond, ctx) => elapsedAtRefresh(cond, ctx).length > 0,
  label: cond => `${cond.aura_spell_name} clipped`,
};
