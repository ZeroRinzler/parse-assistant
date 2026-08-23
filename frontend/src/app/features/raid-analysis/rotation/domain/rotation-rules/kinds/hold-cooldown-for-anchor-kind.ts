import { Injectable } from '@angular/core';
import { round } from '../../../../../../domain/analysis/analysis-math';
import { AnalysisFinding, FindingOccurrence } from '../../../../../../domain/analysis/analysis.models';
import { HoldCooldownForAnchorCondition, RuleSeverity } from '../../../../../../domain/rulebook/rulebook.models';
import { CastTimes, RuleContext } from '../rule-context-service';
import { RuleBand, RuleDomain, RuleJudging, RuleKind, RuleStream } from '../rule-kind';

@Injectable({ providedIn: 'root' })
export class HoldCooldownForAnchorKind extends RuleKind<HoldCooldownForAnchorCondition> {
  readonly kind = 'hold_cooldown_for_anchor';

  streams(): RuleStream[] {
    return [];
  }

  readonly pooling = 'instance';

  // A large gap is a charge spent right after the previous anchor, which is the prompt play, not a hold.

  judging(): RuleJudging {
    return { primary: 'below', twoSided: false };
  }

  domain(): RuleDomain | null {
    return { min: 0, max: null };
  }

  sample(cond: HoldCooldownForAnchorCondition, ctx: RuleContext): number[] {
    return this.gapToNextAnchor(cond, ctx).map(entry => entry.gapS);
  }

  applicable(cond: HoldCooldownForAnchorCondition, ctx: RuleContext): boolean {
    return this.holdAnchors(cond, ctx.castTimes).length > 0
    && cond.spell_ids.some(spellId => this.castCount(ctx, spellId) > 0);
  }

  label(cond: HoldCooldownForAnchorCondition): string {
    return `${cond.spell_names.join('/')} held for ${cond.anchor_spell_name}`;
  }

  /** Non-opener anchor casts: the first is nothing to have held for. */
  private holdAnchors(cond: HoldCooldownForAnchorCondition, castTimes: CastTimes): number[] {
    return [...(castTimes[cond.anchor_spell_id] ?? [])].sort((a, b) => a - b).slice(1);
  }

  /** Gap from each judged cast to the anchor it was spent before, so the sample, the count and the chips all read one definition. */
  private gapToNextAnchor(
    cond: HoldCooldownForAnchorCondition, ctx: RuleContext,
  ): { timeS: number; spellName: string; gapS: number }[] {
    const anchorTimes = this.holdAnchors(cond, ctx.castTimes);
    return cond.spell_ids.flatMap((spellId, i) => {
      const spellName = cond.spell_names[i] ?? String(spellId);
      return (ctx.castTimes[spellId] ?? []).flatMap(castTime => {
        const nextAnchor = anchorTimes.filter(anchorTime => anchorTime > castTime).sort((a, b) => a - b)[0];
        return nextAnchor != null ? [{ timeS: castTime, spellName, gapS: nextAnchor - castTime }] : [];
      });
    }).sort((a, b) => a.timeS - b.timeS);
  }

  private holdForAnchorOccurrences(
    cond: HoldCooldownForAnchorCondition, anchorTimes: number[],
    judged: { timeS: number; spellName: string; gapS: number }[], lo: number,
  ): FindingOccurrence[] {
    const chips: FindingOccurrence[] = anchorTimes.map(anchorTime => ({
      atS: round(anchorTime, 3), ok: true, label: cond.anchor_spell_name, marker: true,
      detail: `${cond.anchor_spell_name} cast here.`,
    }));
    chips.push(...judged.map(({ timeS, spellName, gapS }): FindingOccurrence => ({
      atS: round(timeS, 3), ok: gapS >= lo, label: this.SECONDS.format(gapS),
      detail: `${spellName} cast ${this.SECONDS.format(gapS)} before ${cond.anchor_spell_name}.`,
    })));
    chips.sort((a, b) => (a.atS ?? 0) - (b.atS ?? 0));
    return this.sampleOccurrences(chips);
  }

  protected evaluateBanded(
    cond: HoldCooldownForAnchorCondition, ctx: RuleContext, band: RuleBand, judging: RuleJudging, severity: RuleSeverity, remedy?: string,
  ): AnalysisFinding | null {
    const { lo, hi } = this.bandLimits(this.SECONDS, band);
    const anchorTimes = this.holdAnchors(cond, ctx.castTimes);
    const judged = this.gapToNextAnchor(cond, ctx);
    const violations = judged.filter(entry => this.outOfBand(entry.gapS, lo, hi, judging));
    if (!this.exceedsTolerance(violations.length, judged.length, band)) return null;
    const firstViolation = violations[0];
    if (firstViolation == null) return null;
    const spellNames = [...new Set(violations.map(entry => entry.spellName))].join('/');
    return {
      severity, category: 'rule_violation',
      timestamp_s: round(firstViolation.timeS, 3),
      label: `${spellNames} held before ${cond.anchor_spell_name}`,
      message: `${spellNames} was used right before ${cond.anchor_spell_name} ${violations.length} of ${judged.length} times. Save it when ${cond.anchor_spell_name} is within ${this.SECONDS.format(lo)}.`,
      measured: { value: `${violations.length} / ${judged.length}`, unit: 'charge(s)' },
      details: remedy ? { remedy } : undefined,
      occurrences: this.holdForAnchorOccurrences(cond, anchorTimes, judged, lo),
      occurrenceTarget: `saved when ${cond.anchor_spell_name} is within ${this.SECONDS.format(lo)}`,
    };
  }
}
