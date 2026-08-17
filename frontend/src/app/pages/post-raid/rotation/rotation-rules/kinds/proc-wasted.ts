import { round } from '../../../../../shared/analysis/analysis-math';
import { AnalysisFinding, FindingOccurrence } from '../../../../../core/models/analysis.models';
import { ProcWastedCondition } from '../../../../../core/models/rulebook.models';
import { RuleContext } from '../rule-context';
import {
  KindSpec, PERCENT, RuleBand, RuleJudging, Severity,
  bandLimits, oneIn, outOfBand, sampleOccurrences, withBand,
} from '../engine-core';

/** A proc still up when the pull ends has not been wasted, whether the log closed its span at the kill or left it open. */
function closedProcSpans(cond: ProcWastedCondition, ctx: RuleContext): [number, number][] {
  return (ctx.selfAuras.get(cond.buff_spell_id) ?? [])
    .filter((span): span is [number, number] => span[1] != null && span[1] < ctx.fightDurationS);
}

function procSpent(cond: ProcWastedCondition, ctx: RuleContext): (span: [number, number]) => boolean {
  const spendTimes = cond.spend_spell_ids.flatMap(spellId => ctx.castTimes[spellId] ?? []);
  return ([startS, endS]) => spendTimes.some(time => time >= startS && time <= endS);
}

function wastedProcShare(cond: ProcWastedCondition, ctx: RuleContext): number | null {
  const spans = closedProcSpans(cond, ctx);
  const firstSpan = spans[0];
  if (firstSpan == null) return null;
  const spent = procSpent(cond, ctx);
  return spans.filter(span => !spent(span)).length / spans.length;
}

export function evaluateProcWasted(
  cond: ProcWastedCondition, ctx: RuleContext, band: RuleBand, judging: RuleJudging, severity: Severity, remedy?: string,
): AnalysisFinding | null {
  const { lo, hi } = bandLimits(PERCENT, band);
  const spans = closedProcSpans(cond, ctx);
  if (!spans.length) return null;
  const spent = procSpent(cond, ctx);
  const wasted = spans.filter(span => !spent(span));
  if (!outOfBand(wasted.length / spans.length, lo, hi, judging)) return null;
  // Above-only judging: an out-of-band waste rate implies at least one wasted proc.
  const firstWasted = wasted[0];
  if (firstWasted == null) return null;
  return {
    severity, category: 'rule_violation',
    timestamp_s: round(firstWasted[0], 3),
    label: `${cond.buff_spell_name} wasted`,
    message: `${cond.buff_spell_name} expired unused ${wasted.length} of ${spans.length} times. Top raiders ${hi <= 0 ? 'never waste it' : `waste at most ${oneIn(hi)}`}.`,
    measured: { value: `${wasted.length} / ${spans.length}`, unit: 'proc(s)' },
    details: remedy ? { remedy } : undefined,
    occurrences: sampleOccurrences(spans.map((span): FindingOccurrence => {
      const used = spent(span);
      return {
        atS: round(span[0], 3), ok: used, label: used ? 'used' : 'wasted',
        detail: used ? `${cond.buff_spell_name} was spent before it expired.` : `${cond.buff_spell_name} expired unspent here.`,
      };
    })),
    occurrenceTarget: `spent ${hi <= 0 ? 'every time' : `on all but ${oneIn(hi)}`}`,
  };
}

export const PROC_WASTED_KIND: KindSpec<ProcWastedCondition> = {
  streams: () => [],
  pooling: 'parse',
  judging: () => ({ primary: 'above', twoSided: false }),
  domain: () => ({ min: 0, max: 1 }),
  sample: (cond, ctx) => {
    const share = wastedProcShare(cond, ctx);
    return share == null ? [] : [share];
  },
  evaluate: withBand(evaluateProcWasted),
  applicable: (cond, ctx) => closedProcSpans(cond, ctx).length > 0,
  label: cond => `${cond.buff_spell_name} spent`,
};
