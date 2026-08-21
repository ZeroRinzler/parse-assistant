import { round } from '../../../../../shared/analysis/analysis-math';
import { AnalysisFinding, FindingOccurrence } from '../../../../../core/models/analysis.models';
import { CastOutsideBuffCondition, RuleSeverity } from '../../../../../core/models/rulebook.models';
import { auraUpAt } from '../../../../../shared/analysis/aura-windows';
import { RuleContext, castCount } from '../rule-context';
import {
  KindSpec, PERCENT, RuleBand, RuleJudging,
  bandLimits, oneIn, outOfBand, sampleOccurrences, withBand,
} from '../engine-core';

function castOutsideBuffOccurrences(cond: CastOutsideBuffCondition, ctx: RuleContext, primary: number[]): FindingOccurrence[] {
  return sampleOccurrences(primary.map(time => {
    const up = auraUpAt(ctx.selfAuras, cond.buff_spell_id, time);
    return {
      atS: round(time, 3), ok: up === (cond.require === 'inside'), label: up ? 'up' : 'down',
      detail: `${cond.buff_spell_name} was ${up ? 'up' : 'down'} at this cast.`,
    };
  }));
}

/** One split feeds both the count in the sentence and the share judged against the bar, so the two cannot disagree. */
function castsOffBuffSide(
  cond: CastOutsideBuffCondition, ctx: RuleContext,
): { judged: number[]; violations: number[] } {
  const judged = [...(ctx.castTimes[cond.spell_id] ?? [])].sort((a, b) => a - b);
  const violations = judged.filter(time =>
    auraUpAt(ctx.selfAuras, cond.buff_spell_id, time) !== (cond.require === 'inside'));
  return { judged, violations };
}

function offSideShare(cond: CastOutsideBuffCondition, ctx: RuleContext): number | null {
  const { judged, violations } = castsOffBuffSide(cond, ctx);
  return judged.length ? violations.length / judged.length : null;
}

export function evaluateCastOutsideBuff(
  cond: CastOutsideBuffCondition, ctx: RuleContext, band: RuleBand, judging: RuleJudging, severity: RuleSeverity, remedy?: string,
): AnalysisFinding | null {
  const { lo, hi } = bandLimits(PERCENT, band);
  const { judged, violations } = castsOffBuffSide(cond, ctx);
  if (!judged.length) return null;
  if (!outOfBand(violations.length / judged.length, lo, hi, judging)) return null;
  // Above-only judging: an out-of-band miss rate implies at least one offending cast.
  const firstViolationS = violations[0];
  if (firstViolationS == null) return null;
  const relation = cond.require === 'inside' ? 'without' : 'during';
  return {
    severity, category: 'rule_violation',
    timestamp_s: round(firstViolationS, 3),
    label: `${cond.spell_name} ${relation} ${cond.buff_spell_name}`,
    message: `${violations.length} of ${judged.length} ${cond.spell_name} casts landed ${relation} ${cond.buff_spell_name}. Top raiders ${hi <= 0 ? 'never miss it' : `miss at most ${oneIn(hi)}`}.`,
    measured: { value: `${violations.length} / ${judged.length}`, unit: 'cast(s)' },
    details: remedy ? { remedy } : undefined,
    occurrences: castOutsideBuffOccurrences(cond, ctx, judged),
    occurrenceTarget: `${cond.buff_spell_name} ${cond.require === 'inside' ? 'up' : 'down'} ${hi <= 0 ? 'every cast' : `on all but ${oneIn(hi)}`}`,
  };
}

export const CAST_OUTSIDE_BUFF_KIND: KindSpec<CastOutsideBuffCondition> = {
  streams: () => [],
  pooling: 'parse',
  judging: () => ({ primary: 'above', twoSided: false }),
  domain: () => ({ min: 0, max: 1 }),
  sample: (cond, ctx) => {
    const share = offSideShare(cond, ctx);
    return share == null ? [] : [share];
  },
  evaluate: withBand(evaluateCastOutsideBuff),
  applicable: (cond, ctx) => castCount(ctx, cond.spell_id) > 0,
  label: cond => `${cond.spell_name} ${cond.require} ${cond.buff_spell_name}`,
};
