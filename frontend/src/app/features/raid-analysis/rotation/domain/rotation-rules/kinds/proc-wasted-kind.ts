import { Injectable } from '@angular/core';
import { round } from '../../../../../../domain/analysis/analysis-math';
import { AnalysisFinding, FindingOccurrence } from '../../../../../../domain/analysis/analysis.models';
import { ProcWastedCondition, RuleSeverity } from '../../../../../../domain/rulebook/rulebook.models';
import { RuleContext } from '../rule-context-service';
import { RuleBand, RuleDomain, RuleJudging, RuleKind, RuleStream } from '../rule-kind';

@Injectable({ providedIn: 'root' })
export class ProcWastedKind extends RuleKind<ProcWastedCondition> {
  readonly kind = 'proc_wasted';

  streams(): RuleStream[] {
    return [];
  }

  readonly pooling = 'parse';

  judging(): RuleJudging {
    return { primary: 'above', twoSided: false };
  }

  domain(): RuleDomain | null {
    return { min: 0, max: 1 };
  }

  sample(cond: ProcWastedCondition, ctx: RuleContext): number[] {
    const share = this.wastedProcShare(cond, ctx);
    return share == null ? [] : [share];
  }

  applicable(cond: ProcWastedCondition, ctx: RuleContext): boolean {
    return this.closedProcSpans(cond, ctx).length > 0;
  }

  label(cond: ProcWastedCondition): string {
    return `${cond.buff_spell_name} spent`;
  }

  /** A proc still up when the pull ends has not been wasted, whether the log closed its span at the kill or left it open. */
  private closedProcSpans(cond: ProcWastedCondition, ctx: RuleContext): [number, number][] {
    return (ctx.selfAuras.get(cond.buff_spell_id) ?? [])
      .filter((span): span is [number, number] => span[1] != null && span[1] < ctx.fightDurationS);
  }

  private procSpent(cond: ProcWastedCondition, ctx: RuleContext): (span: [number, number]) => boolean {
    const spendTimes = cond.spend_spell_ids.flatMap(spellId => ctx.castTimes[spellId] ?? []);
    return ([startS, endS]) => spendTimes.some(time => time >= startS && time <= endS);
  }

  private wastedProcShare(cond: ProcWastedCondition, ctx: RuleContext): number | null {
    const spans = this.closedProcSpans(cond, ctx);
    const firstSpan = spans[0];
    if (firstSpan == null) return null;
    const spent = this.procSpent(cond, ctx);
    return spans.filter(span => !spent(span)).length / spans.length;
  }

  protected evaluateBanded(
    cond: ProcWastedCondition, ctx: RuleContext, band: RuleBand, judging: RuleJudging, severity: RuleSeverity, remedy?: string,
  ): AnalysisFinding | null {
    const { lo, hi } = this.bandLimits(this.PERCENT, band);
    const spans = this.closedProcSpans(cond, ctx);
    if (!spans.length) return null;
    const spent = this.procSpent(cond, ctx);
    const wasted = spans.filter(span => !spent(span));
    if (!this.outOfBand(wasted.length / spans.length, lo, hi, judging)) return null;
    // Above-only judging: an out-of-band waste rate implies at least one wasted proc.
    const firstWasted = wasted[0];
    if (firstWasted == null) return null;
    return {
      severity, category: 'rule_violation',
      timestamp_s: round(firstWasted[0], 3),
      label: `${cond.buff_spell_name} wasted`,
      message: `${cond.buff_spell_name} expired unused ${wasted.length} of ${spans.length} times. Top raiders ${hi <= 0 ? 'never waste it' : `waste at most ${this.oneIn(hi)}`}.`,
      measured: { value: `${wasted.length} / ${spans.length}`, unit: 'proc(s)' },
      details: remedy ? { remedy } : undefined,
      occurrences: this.sampleOccurrences(spans.map((span): FindingOccurrence => {
        const used = spent(span);
        return {
          atS: round(span[0], 3), ok: used, label: used ? 'used' : 'wasted',
          detail: used ? `${cond.buff_spell_name} was spent before it expired.` : `${cond.buff_spell_name} expired unspent here.`,
        };
      })),
      occurrenceTarget: `spent ${hi <= 0 ? 'every time' : `on all but ${this.oneIn(hi)}`}`,
    };
  }
}
