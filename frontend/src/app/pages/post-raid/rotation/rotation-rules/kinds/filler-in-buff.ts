import { AnalysisFinding } from '../../../../../core/models/analysis.models';
import { FillerInBuffCondition, RuleSeverity } from '../../../../../core/models/rulebook.models';
import { auraAlreadyUpAt } from '../../../../../shared/analysis/aura-windows';
import { RuleContext, suspendedAt } from '../rule-context';
import { KindSpec, PERCENT, RuleBand, RuleJudging, bandLimits, withBand } from '../engine-core';
import { FillerSplit, fillerFinding, fillerOccurrences, fillerShare, splitFillers } from '../filler-choice';

function fillerInBuffTimesFor(cond: FillerInBuffCondition, ctx: RuleContext): (spellId: number) => number[] {
  return spellId => (ctx.castTimes[spellId] ?? []).filter(time =>
    auraAlreadyUpAt(ctx.selfAuras, cond.buff_spell_id, time)
    && !suspendedAt(cond.except_buff_spell_ids, ctx, time));
}

function fillerCastsInBuff(cond: FillerInBuffCondition, ctx: RuleContext): FillerSplit {
  return splitFillers(cond.spell_id, cond.alternative_spell_ids, fillerInBuffTimesFor(cond, ctx));
}

export function evaluateFillerInBuff(
  cond: FillerInBuffCondition, ctx: RuleContext, band: RuleBand, judging: RuleJudging, severity: RuleSeverity, remedy?: string,
): AnalysisFinding | null {
  const finding = fillerFinding(fillerCastsInBuff(cond, ctx), band, judging, severity,
    cond.spell_name, `during ${cond.buff_spell_name}`, remedy);
  if (!finding) return null;
  return {
    ...finding,
    occurrences: fillerOccurrences(
      cond.spell_id, cond.spell_name, cond.alternative_spell_ids, cond.alternative_spell_names,
      fillerInBuffTimesFor(cond, ctx),
    ),
    occurrenceTarget: `${PERCENT.format(bandLimits(PERCENT, band).lo)} or more ${cond.spell_name} during ${cond.buff_spell_name}`,
  };
}

export const FILLER_IN_BUFF_KIND: KindSpec<FillerInBuffCondition> = {
  streams: () => [],
  pooling: 'parse',
  judging: () => ({ primary: 'below', twoSided: false }),
  domain: () => ({ min: 0, max: 1 }),
  sample: (cond, ctx) => {
    const share = fillerShare(fillerCastsInBuff(cond, ctx));
    return share == null ? [] : [share];
  },
  evaluate: withBand(evaluateFillerInBuff),
  applicable: (cond, ctx) => fillerCastsInBuff(cond, ctx).total > 0,
  label: cond => `${cond.spell_name} in ${cond.buff_spell_name}`,
};
