import { AnalysisFinding } from '../../../../../core/models/analysis.models';
import { FillerBelowHealthCondition } from '../../../../../core/models/rulebook.models';
import { TimedEvent, targetKey } from '../../../../../shared/analysis/wcl-projections';
import { HealthRow, RuleContext, suspendedAt } from '../rule-context';
import { KindSpec, PERCENT, RuleBand, RuleJudging, Severity, bandLimits, withBand } from '../engine-core';
import { FillerSplit, fillerFinding, fillerOccurrences, fillerShare, splitFillers } from '../filler-choice';

/** Health is sampled on hits rather than casts, and falls fast in execute range, so a cast reads back only this far. */
const HEALTH_SAMPLE_WINDOW_S = 2;

/** Health rides on damage rows rather than casts, so a cast reads the latest snapshot of THE ENEMY IT NAMED - a tick on a dying add otherwise licenses an execute against a full-health boss. */
function targetHealthFracAt(ctx: RuleContext, cast: TimedEvent): number | null {
  const castS = cast.atS;
  const rows = ctx.targetHealth(targetKey(cast));
  let latest: HealthRow | undefined;
  for (const row of rows) {
    if (row[0] > castS) break;
    latest = row;
  }
  if (!latest || latest[0] < castS - HEALTH_SAMPLE_WINDOW_S) return null;
  return latest[1];
}

function fillerBelowHealthTimesFor(cond: FillerBelowHealthCondition, ctx: RuleContext): (spellId: number) => number[] {
  const gate = cond.health_pct / 100;
  return spellId => ctx.castEvents
    .filter(event => {
      if (event.type !== 'cast' || event.abilityGameID !== spellId) return false;
      if (suspendedAt(cond.except_buff_spell_ids, ctx, event.atS)) return false;
      const frac = targetHealthFracAt(ctx, event);
      return frac != null && frac <= gate;
    })
    .map(event => event.atS);
}

function fillersBelowHealth(cond: FillerBelowHealthCondition, ctx: RuleContext): FillerSplit {
  return splitFillers(cond.spell_id, cond.alternative_spell_ids, fillerBelowHealthTimesFor(cond, ctx));
}

export function evaluateFillerBelowHealth(
  cond: FillerBelowHealthCondition, ctx: RuleContext, band: RuleBand, judging: RuleJudging, severity: Severity, remedy?: string,
): AnalysisFinding | null {
  const finding = fillerFinding(fillersBelowHealth(cond, ctx), band, judging, severity,
    cond.spell_name, `under ${cond.health_pct}% health`, remedy);
  if (!finding) return null;
  return {
    ...finding,
    occurrences: fillerOccurrences(
      cond.spell_id, cond.spell_name, cond.alternative_spell_ids, cond.alternative_spell_names,
      fillerBelowHealthTimesFor(cond, ctx),
    ),
    occurrenceTarget: `${PERCENT.format(bandLimits(PERCENT, band).lo)} or more ${cond.spell_name} under ${cond.health_pct}% health`,
  };
}

export const FILLER_BELOW_HEALTH_KIND: KindSpec<FillerBelowHealthCondition> = {
  streams: () => ['damage', 'targetHealth'],
  pooling: 'parse',
  judging: () => ({ primary: 'below', twoSided: false }),
  domain: () => ({ min: 0, max: 1 }),
  sample: (cond, ctx) => {
    const share = fillerShare(fillersBelowHealth(cond, ctx));
    return share == null ? [] : [share];
  },
  evaluate: withBand(evaluateFillerBelowHealth),
  applicable: (cond, ctx) => fillersBelowHealth(cond, ctx).total > 0,
  label: cond => `${cond.spell_name} under ${cond.health_pct}% health`,
};
