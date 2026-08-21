import { round } from '../../../../../shared/analysis/analysis-math';
import { AnalysisFinding, FindingOccurrence } from '../../../../../core/models/analysis.models';
import { OpeningSequenceCondition, RuleSeverity } from '../../../../../core/models/rulebook.models';
import { RuleContext, castCount } from '../rule-context';
import { KindSpec, RuleBand, RuleJudging, SECONDS, bandLimits, withBand } from '../engine-core';

function openerProgress(
  cond: OpeningSequenceCondition, ctx: RuleContext, windowS: number,
): { pullS: number; matched: number; completedS: number | null } | null {
  const all = Object.values(ctx.castTimes).flat();
  if (!all.length) return null;
  const pullS = Math.min(...all);
  const deadlineS = pullS + windowS;
  let cursor = pullS;
  let matched = 0;
  for (const spellId of cond.spell_ids) {
    const next = (ctx.castTimes[spellId] ?? [])
      .filter(time => time >= cursor && time <= deadlineS)
      .sort((a, b) => a - b)[0];
    if (next == null) break;
    cursor = next;
    matched++;
  }
  return { pullS, matched, completedS: matched === cond.spell_ids.length ? cursor - pullS : null };
}

interface OpenerStepResult { ok: boolean; atS?: number; name: string; }

/** Every step's own result, unlike `openerProgress` which stops walking at the first miss - a later step can still land. */
function openerSteps(cond: OpeningSequenceCondition, ctx: RuleContext, pullS: number, deadlineS: number): OpenerStepResult[] {
  let cursor = pullS;
  return cond.spell_ids.map((spellId, i) => {
    const name = cond.spell_names[i] ?? String(spellId);
    const next = (ctx.castTimes[spellId] ?? [])
      .filter(time => time >= cursor && time <= deadlineS)
      .sort((a, b) => a - b)[0];
    if (next == null) return { ok: false, name };
    cursor = next;
    return { ok: true, atS: round(next, 3), name };
  });
}

function openingSequenceOccurrences(
  cond: OpeningSequenceCondition, ctx: RuleContext, pullS: number, deadlineS: number,
): FindingOccurrence[] {
  return openerSteps(cond, ctx, pullS, deadlineS).map(step =>
    step.ok
      ? { atS: step.atS, ok: true, label: step.name, detail: `${step.name} landed on time in its slot.` }
      : { ok: false, label: step.name, note: 'not reached', detail: `${step.name} was never reached in the opener window.` });
}

export function evaluateOpeningSequence(
  cond: OpeningSequenceCondition, ctx: RuleContext, band: RuleBand, _judging: RuleJudging, severity: RuleSeverity, remedy?: string,
): AnalysisFinding | null {
  const hi = bandLimits(SECONDS, band).hi;
  const progress = openerProgress(cond, ctx, hi);
  if (!progress || progress.completedS != null) return null;
  return {
    severity, category: 'rule_violation',
    timestamp_s: round(progress.pullS, 3),
    label: `Opener: ${cond.spell_names.join(' > ')}`,
    message: `Your opener got ${progress.matched} of ${cond.spell_ids.length} steps out. Top raiders finish all ${cond.spell_ids.length} within ${SECONDS.format(hi)}.`,
    measured: { value: `${progress.matched} / ${cond.spell_ids.length}`, unit: 'step(s)' },
    details: remedy ? { remedy } : undefined,
    occurrences: openingSequenceOccurrences(cond, ctx, progress.pullS, progress.pullS + hi),
    occurrenceTarget: `expected order: ${cond.spell_names.join(' > ')}`,
  };
}

export const OPENING_SEQUENCE_KIND: KindSpec<OpeningSequenceCondition> = {
  streams: () => [],
  pooling: 'parse',
  judging: () => ({ primary: 'above', twoSided: false }),
  domain: () => ({ min: 0, max: null }),
  // Measured against the whole pull, since the window being derived cannot gate its own measurement.
  sample: (cond, ctx) => {
    const completedS = openerProgress(cond, ctx, ctx.fightDurationS)?.completedS;
    return completedS == null ? [] : [completedS];
  },
  evaluate: withBand(evaluateOpeningSequence),
  applicable: (cond, ctx) => cond.spell_ids.some(spellId => castCount(ctx, spellId) > 0),
  label: cond => `Opener: ${cond.spell_names.join(' > ')}`,
};
