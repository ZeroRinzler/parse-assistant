import { round } from '../../../../../shared/analysis/analysis-math';
import { AnalysisFinding, FindingOccurrence } from '../../../../../core/models/analysis.models';
import { HoldCooldownForAnchorCondition } from '../../../../../core/models/rulebook.models';
import { CastTimes, RuleContext, castCount } from '../rule-context';
import {
  KindSpec, RuleBand, RuleJudging, SECONDS, Severity,
  bandLimits, exceedsTolerance, outOfBand, sampleOccurrences, withBand,
} from '../engine-core';

/** Non-opener anchor casts: the first is nothing to have held for. */
function holdAnchors(cond: HoldCooldownForAnchorCondition, castTimes: CastTimes): number[] {
  return [...(castTimes[cond.anchor_spell_id] ?? [])].sort((a, b) => a - b).slice(1);
}

/** Gap from each judged cast to the anchor it was spent before, so the sample, the count and the chips all read one definition. */
function gapToNextAnchor(
  cond: HoldCooldownForAnchorCondition, ctx: RuleContext,
): { timeS: number; spellName: string; gapS: number }[] {
  const anchorTimes = holdAnchors(cond, ctx.castTimes);
  return cond.spell_ids.flatMap((spellId, i) => {
    const spellName = cond.spell_names[i] ?? String(spellId);
    return (ctx.castTimes[spellId] ?? []).flatMap(castTime => {
      const nextAnchor = anchorTimes.filter(anchorTime => anchorTime > castTime).sort((a, b) => a - b)[0];
      return nextAnchor != null ? [{ timeS: castTime, spellName, gapS: nextAnchor - castTime }] : [];
    });
  }).sort((a, b) => a.timeS - b.timeS);
}

function holdForAnchorOccurrences(
  cond: HoldCooldownForAnchorCondition, anchorTimes: number[],
  judged: { timeS: number; spellName: string; gapS: number }[], lo: number,
): FindingOccurrence[] {
  const chips: FindingOccurrence[] = anchorTimes.map(anchorTime => ({
    atS: round(anchorTime, 3), ok: true, label: cond.anchor_spell_name, marker: true,
    detail: `${cond.anchor_spell_name} cast here.`,
  }));
  chips.push(...judged.map(({ timeS, spellName, gapS }): FindingOccurrence => ({
    atS: round(timeS, 3), ok: gapS >= lo, label: SECONDS.format(gapS),
    detail: `${spellName} cast ${SECONDS.format(gapS)} before ${cond.anchor_spell_name}.`,
  })));
  chips.sort((a, b) => (a.atS ?? 0) - (b.atS ?? 0));
  return sampleOccurrences(chips);
}

export function evaluateHoldForAnchor(
  cond: HoldCooldownForAnchorCondition, ctx: RuleContext, band: RuleBand, judging: RuleJudging, severity: Severity, remedy?: string,
): AnalysisFinding | null {
  const { lo, hi } = bandLimits(SECONDS, band);
  const anchorTimes = holdAnchors(cond, ctx.castTimes);
  const judged = gapToNextAnchor(cond, ctx);
  const violations = judged.filter(entry => outOfBand(entry.gapS, lo, hi, judging));
  if (!exceedsTolerance(violations.length, judged.length, band)) return null;
  const firstViolation = violations[0];
  if (firstViolation == null) return null;
  const spellNames = [...new Set(violations.map(entry => entry.spellName))].join('/');
  return {
    severity, category: 'rule_violation',
    timestamp_s: round(firstViolation.timeS, 3),
    label: `${spellNames} held before ${cond.anchor_spell_name}`,
    message: `${spellNames} was used right before ${cond.anchor_spell_name} ${violations.length} of ${judged.length} times. Save it when ${cond.anchor_spell_name} is within ${SECONDS.format(lo)}.`,
    measured: { value: `${violations.length} / ${judged.length}`, unit: 'charge(s)' },
    details: remedy ? { remedy } : undefined,
    occurrences: holdForAnchorOccurrences(cond, anchorTimes, judged, lo),
    occurrenceTarget: `saved when ${cond.anchor_spell_name} is within ${SECONDS.format(lo)}`,
  };
}

export const HOLD_COOLDOWN_FOR_ANCHOR_KIND: KindSpec<HoldCooldownForAnchorCondition> = {
  streams: () => [],
  pooling: 'instance',
  // A large gap is a charge spent right after the previous anchor, which is the prompt play, not a hold.
  judging: () => ({ primary: 'below', twoSided: false }),
  domain: () => ({ min: 0, max: null }),
  sample: (cond, ctx) => gapToNextAnchor(cond, ctx).map(entry => entry.gapS),
  evaluate: withBand(evaluateHoldForAnchor),
  applicable: (cond, ctx) => holdAnchors(cond, ctx.castTimes).length > 0
    && cond.spell_ids.some(spellId => castCount(ctx, spellId) > 0),
  label: cond => `${cond.spell_names.join('/')} held for ${cond.anchor_spell_name}`,
};
