import { Injectable } from '@angular/core';
import { median } from 'd3-array';
import { round } from '../../../../../../domain/analysis/analysis-math';
import { AnalysisFinding, FindingOccurrence } from '../../../../../../domain/analysis/analysis.models';
import { AuraClippedCondition, RuleSeverity } from '../../../../../../domain/rulebook/rulebook.models';
import { AuraSpan, AuraSpansByTarget } from '../../../../../../domain/analysis/aura-windows-service';
import { RuleContext } from '../rule-context-service';
import { RuleBand, RuleDomain, RuleJudging, RuleKind, RuleStream } from '../rule-kind';

/** A re-application this soon AFTER a cast is that cast landing: measured deltas run 0-28ms, so this covers projectile flight without reaching the next proc. */
const HARD_CAST_WINDOW_S = 0.25;

type ClosedSpan = AuraSpan & { endS: number };

@Injectable({ providedIn: 'root' })
export class AuraClippedKind extends RuleKind<AuraClippedCondition> {
  readonly kind = 'aura_clipped';

  streams(cond: AuraClippedCondition): RuleStream[] {
    return cond.on === 'target' ? ['enemyAuras'] : [];
  }

  readonly pooling = 'instance';

  judging(): RuleJudging {
    return { primary: 'below', twoSided: false };
  }

  domain(): RuleDomain | null {
    return { min: 0, max: null };
  }

  sample(cond: AuraClippedCondition, ctx: RuleContext): number[] {
    return this.elapsedAtRefresh(cond, ctx).map(entry => entry.elapsedS);
  }

  applicable(cond: AuraClippedCondition, ctx: RuleContext): boolean {
    return this.elapsedAtRefresh(cond, ctx).length > 0;
  }

  label(cond: AuraClippedCondition): string {
    return `${cond.aura_spell_name} clipped`;
  }

  /** Narrows in one place, so the spans that ran to an end are handled without asserting on every read. */
  private closedSpans(perTarget: AuraSpansByTarget): ClosedSpan[] {
    return [...perTarget.values()].flat().filter((span): span is ClosedSpan => span.endS != null);
  }

  private clipSpans(cond: AuraClippedCondition, ctx: RuleContext): AuraSpansByTarget {
    return cond.on === 'target' ? ctx.targetSpans(cond.aura_spell_id) : ctx.selfSpans(cond.aura_spell_id);
  }

  /** Only a re-application the player cast counts, since most refreshes in a log are procs rather than presses. */
  private hardCastRefreshes(cond: AuraClippedCondition, ctx: RuleContext): ClosedSpan[] {
    const castTimes = ctx.castTimes[cond.cast_spell_id] ?? [];
    // One-sided: a cast after the refresh cannot have caused it.
    const cast = (atS: number) => castTimes.some(time => atS - time >= 0 && atS - time <= HARD_CAST_WINDOW_S);
    return this.closedSpans(this.clipSpans(cond, ctx))
      .filter(span => span.endedByRefresh && cast(span.endS)
        && !this.suspendedAt(cond.except_buff_spell_ids, ctx, span.endS));
  }

  /** Needs no authored duration, so neither a death-truncated span nor a pandemic-extended one can skew it. */
  private elapsedAtRefresh(cond: AuraClippedCondition, ctx: RuleContext): { timeS: number; elapsedS: number }[] {
    return this.hardCastRefreshes(cond, ctx)
      .map(span => ({ timeS: span.endS, elapsedS: span.endS - span.startS }))
      .sort((a, b) => a.timeS - b.timeS);
  }

  protected evaluateBanded(
    cond: AuraClippedCondition, ctx: RuleContext, band: RuleBand, judging: RuleJudging, severity: RuleSeverity, remedy?: string,
  ): AnalysisFinding | null {
    const { lo, hi } = this.bandLimits(this.SECONDS, band);
    const judged = this.elapsedAtRefresh(cond, ctx);
    if (!judged.length) return null;
    const clipped = judged.filter(({ elapsedS }) => this.outOfBand(elapsedS, lo, hi, judging));
    if (!this.exceedsTolerance(clipped.length, judged.length, band)) return null;
    const firstClipped = clipped[0];
    if (firstClipped == null) return null;
    const outValues = clipped.map(entry => entry.elapsedS);
    return {
      severity, category: 'rule_violation',
      timestamp_s: round(firstClipped.timeS, 3),
      label: `${cond.aura_spell_name} clipped`,
      message: `You refreshed ${cond.aura_spell_name} early ${clipped.length} of ${judged.length} times, on average ${this.SECONDS.format(median(outValues) ?? 0)} in. Let it run at least ${this.SECONDS.format(lo)}.`,
      measured: { value: `${clipped.length} / ${judged.length}`, unit: 'refresh(es)' },
      details: remedy ? { remedy } : undefined,
      occurrences: this.sampleOccurrences(judged.map(({ timeS, elapsedS }): FindingOccurrence => ({
        atS: round(timeS, 3), ok: !this.outOfBand(elapsedS, lo, hi, judging), label: this.SECONDS.format(elapsedS),
        detail: `Refreshed ${this.SECONDS.format(elapsedS)} into the aura.`,
      }))),
      occurrenceTarget: `let it run at least ${this.SECONDS.format(lo)}`,
    };
  }
}
