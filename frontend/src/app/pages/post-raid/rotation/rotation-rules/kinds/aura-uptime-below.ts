import { round } from '../../../../../shared/analysis/analysis-math';
import { AnalysisFinding, FindingOccurrence } from '../../../../../core/models/analysis.models';
import { AuraUptimeBelowCondition } from '../../../../../core/models/rulebook.models';
import { AuraWindows, auraUptimePct } from '../../../../../shared/analysis/aura-windows';
import { RuleContext } from '../rule-context';
import {
  KindSpec, PERCENT_POINTS, RuleBand, RuleJudging, Severity,
  bandLimits, outOfBand, withBand,
} from '../engine-core';

function uptimePct(cond: AuraUptimeBelowCondition, ctx: RuleContext): number {
  const windows = cond.on === 'target' ? ctx.targetAuras : ctx.selfAuras;
  return auraUptimePct(windows, cond.aura_spell_id, ctx.fightDurationS);
}

/** Overlapping spans merged (a multi-target debuff reads as "up somewhere"), clipped to `[0, boundS]`. */
function mergedUpSpans(windows: AuraWindows, spellId: number, boundS: number): [number, number][] {
  const spans = (windows.get(spellId) ?? [])
    .map(([start, end]): [number, number] => [Math.max(0, start), Math.min(boundS, end ?? boundS)])
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [start, end] of spans) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

/** Longest gaps in a merged coverage timeline, since those - not uniform drift - are what a maintain miss usually is. */
const MAX_UPTIME_GAPS = 3;

/** Below this, a gap is travel time or event-ordering noise rather than a missed refresh - and would render as a nonsensical "0s" chip anyway. */
const MIN_UPTIME_GAP_S = 1;

function uptimeGaps(merged: [number, number][], boundS: number): [number, number][] {
  const gaps: [number, number][] = [];
  let cursor = 0;
  for (const [start, end] of merged) {
    if (start > cursor) gaps.push([cursor, start]);
    cursor = Math.max(cursor, end);
  }
  if (cursor < boundS) gaps.push([cursor, boundS]);
  return gaps
    .filter(([start, end]) => end - start >= MIN_UPTIME_GAP_S)
    .sort((a, b) => (b[1] - b[0]) - (a[1] - a[0])).slice(0, MAX_UPTIME_GAPS).sort((a, b) => a[0] - b[0]);
}

export function evaluateAuraUptimeBelow(
  cond: AuraUptimeBelowCondition, ctx: RuleContext, band: RuleBand, judging: RuleJudging, severity: Severity, remedy?: string,
): AnalysisFinding | null {
  const { lo, hi } = bandLimits(PERCENT_POINTS, band);
  const pct = uptimePct(cond, ctx);
  // Zero uptime reads as a build that skips the aura rather than a mistake, which the app does not guess at.
  if (pct <= 0 || !outOfBand(pct, lo, hi, judging)) return null;
  const windows = cond.on === 'target' ? ctx.targetAuras : ctx.selfAuras;
  const merged = mergedUpSpans(windows, cond.aura_spell_id, ctx.fightDurationS);
  const gaps = uptimeGaps(merged, ctx.fightDurationS);
  return {
    severity, category: 'rule_violation',
    label: `${cond.aura_spell_name} uptime`,
    message: `${cond.aura_spell_name} was up ${PERCENT_POINTS.format(pct)} of the fight. Aim for ${PERCENT_POINTS.format(lo)} or more.`,
    measured: { value: `${Math.round(pct)} / ${Math.round(lo)}`, unit: '% uptime' },
    details: remedy ? { remedy } : undefined,
    occurrences: gaps.map(([start, end]): FindingOccurrence => ({
      atS: round(start, 3), ok: false, label: `${round(end - start, 0)}s`,
      detail: `${cond.aura_spell_name} was down here for ${round(end - start, 0)}s.`,
    })),
    timeline: { segmentsS: merged, fightDurationS: ctx.fightDurationS },
  };
}

export const AURA_UPTIME_BELOW_KIND: KindSpec<AuraUptimeBelowCondition> = {
  streams: cond => cond.on === 'target' ? ['enemyAuras'] : [],
  pooling: 'parse',
  judging: () => ({ primary: 'below', twoSided: false }),
  domain: () => ({ min: 0, max: 100 }),
  sample: (cond, ctx) => {
    const pct = uptimePct(cond, ctx);
    return pct > 0 ? [pct] : [];
  },
  evaluate: withBand(evaluateAuraUptimeBelow),
  applicable: (cond, ctx) => uptimePct(cond, ctx) > 0,
  label: cond => `${cond.aura_spell_name} uptime`,
};
