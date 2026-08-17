import { round } from '../../../../../shared/analysis/analysis-math';
import { AnalysisFinding, FindingOccurrence } from '../../../../../core/models/analysis.models';
import { CastWithoutPriorCondition } from '../../../../../core/models/rulebook.models';
import { CastTimes, RuleContext, castCount } from '../rule-context';
import {
  KindSpec, RuleBand, RuleJudging, SECONDS, Severity,
  bandLimits, exceedsTolerance, outOfBand, sampleOccurrences, withBand,
} from '../engine-core';

/** The tightest lead each cast achieved on the required side, or null when a cast never paired at all. */
function leadPerCast(cond: CastWithoutPriorCondition, castTimes: CastTimes): (number | null)[] {
  const position = cond.position ?? 'before';
  const required = castTimes[cond.required_spell_id] ?? [];
  return [...(castTimes[cond.spell_id] ?? [])].sort((a, b) => a - b).map(time => {
    const leads = required.map(rt => time - rt)
      .filter(lead => position === 'either' || (position === 'before' ? lead >= 0 : lead <= 0))
      .map(Math.abs);
    return leads.length ? Math.min(...leads) : null;
  });
}

function castWithoutPriorOccurrences(
  cond: CastWithoutPriorCondition, castTimes: CastTimes, hi: number,
): FindingOccurrence[] {
  const primary = [...(castTimes[cond.spell_id] ?? [])].sort((a, b) => a - b);
  const leads = leadPerCast(cond, castTimes);
  return sampleOccurrences(primary.map((time, i) => {
    const lead = leads[i];
    const ok = lead != null && lead <= hi;
    return {
      atS: round(time, 3), ok,
      label: lead == null ? 'none' : `${round(lead, 1)}s`,
      detail: lead == null
        ? `No ${cond.required_spell_name} paired with this cast.`
        : `${cond.required_spell_name} landed ${round(lead, 1)}s from this cast.`,
    };
  }));
}

export function evaluateCastWithoutPrior(
  cond: CastWithoutPriorCondition, ctx: RuleContext, band: RuleBand, judging: RuleJudging, severity: Severity, remedy?: string,
): AnalysisFinding | null {
  const { lo, hi } = bandLimits(SECONDS, band);
  const castTimes = ctx.castTimes;
  const primary = [...(castTimes[cond.spell_id] ?? [])].sort((a, b) => a - b);
  const leads = leadPerCast(cond, castTimes);
  const violations = primary.filter((_, i) => {
    const lead = leads[i];
    return lead == null || outOfBand(lead, lo, hi, judging);
  });
  if (!exceedsTolerance(violations.length, primary.length, band)) return null;
  const firstViolationS = violations[0];
  if (firstViolationS == null) return null;
  return {
    severity, category: 'rule_violation',
    timestamp_s: round(firstViolationS, 3),
    label: `${cond.spell_name} without ${cond.required_spell_name}`,
    message: `${violations.length} of ${primary.length} ${cond.spell_name} casts had no ${cond.required_spell_name} before them. Cast it within ${SECONDS.format(hi)} of ${cond.required_spell_name}.`,
    measured: { value: `${violations.length} / ${primary.length}`, unit: 'cast(s)' },
    details: remedy ? { remedy } : undefined,
    occurrences: castWithoutPriorOccurrences(cond, castTimes, hi),
    occurrenceTarget: `within ${SECONDS.format(hi)} of ${cond.required_spell_name}`,
  };
}

export const CAST_WITHOUT_PRIOR_KIND: KindSpec<CastWithoutPriorCondition> = {
  streams: () => [],
  pooling: 'instance',
  judging: () => ({ primary: 'above', twoSided: false }),
  domain: () => ({ min: 0, max: null }),
  sample: (cond, ctx) => leadPerCast(cond, ctx.castTimes).filter((lead): lead is number => lead != null),
  // An unpaired cast is the violation this kind is named for, but it has no lead to pool, so it reaches tolerance this way instead.
  unmeasured: (cond, ctx) => leadPerCast(cond, ctx.castTimes).filter(lead => lead == null).length,
  evaluate: withBand(evaluateCastWithoutPrior),
  applicable: (cond, ctx) => castCount(ctx, cond.spell_id) > 0,
  label: cond => `${cond.spell_name} with ${cond.required_spell_name}`,
};
