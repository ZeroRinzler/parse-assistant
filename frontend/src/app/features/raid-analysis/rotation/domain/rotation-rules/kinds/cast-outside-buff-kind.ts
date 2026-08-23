import { Injectable } from '@angular/core';
import { round } from '../../../../../../domain/analysis/analysis-math';
import { AnalysisFinding, FindingOccurrence } from '../../../../../../domain/analysis/analysis.models';
import { CastOutsideBuffCondition, RuleSeverity } from '../../../../../../domain/rulebook/rulebook.models';
import { RuleContext } from '../rule-context-service';
import { RuleBand, RuleDomain, RuleJudging, RuleKind, RuleStream } from '../rule-kind';

@Injectable({ providedIn: 'root' })
export class CastOutsideBuffKind extends RuleKind<CastOutsideBuffCondition> {
  readonly kind = 'cast_outside_buff';

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

  sample(cond: CastOutsideBuffCondition, ctx: RuleContext): number[] {
    const share = this.offSideShare(cond, ctx);
    return share == null ? [] : [share];
  }

  applicable(cond: CastOutsideBuffCondition, ctx: RuleContext): boolean {
    return this.castCount(ctx, cond.spell_id) > 0;
  }

  label(cond: CastOutsideBuffCondition): string {
    return `${cond.spell_name} ${cond.require} ${cond.buff_spell_name}`;
  }

  private castOutsideBuffOccurrences(cond: CastOutsideBuffCondition, ctx: RuleContext, primary: number[]): FindingOccurrence[] {
    return this.sampleOccurrences(primary.map(time => {
      const up = this.auraWindows.auraUpAt(ctx.selfAuras, cond.buff_spell_id, time);
      return {
        atS: round(time, 3), ok: up === (cond.require === 'inside'), label: up ? 'up' : 'down',
        detail: `${cond.buff_spell_name} was ${up ? 'up' : 'down'} at this cast.`,
      };
    }));
  }

  /** One split feeds both the count in the sentence and the share judged against the bar, so the two cannot disagree. */
  private castsOffBuffSide(
    cond: CastOutsideBuffCondition, ctx: RuleContext,
  ): { judged: number[]; violations: number[] } {
    const judged = [...(ctx.castTimes[cond.spell_id] ?? [])].sort((a, b) => a - b);
    const violations = judged.filter(time =>
      this.auraWindows.auraUpAt(ctx.selfAuras, cond.buff_spell_id, time) !== (cond.require === 'inside'));
    return { judged, violations };
  }

  private offSideShare(cond: CastOutsideBuffCondition, ctx: RuleContext): number | null {
    const { judged, violations } = this.castsOffBuffSide(cond, ctx);
    return judged.length ? violations.length / judged.length : null;
  }

  protected evaluateBanded(
    cond: CastOutsideBuffCondition, ctx: RuleContext, band: RuleBand, judging: RuleJudging, severity: RuleSeverity, remedy?: string,
  ): AnalysisFinding | null {
    const { lo, hi } = this.bandLimits(this.PERCENT, band);
    const { judged, violations } = this.castsOffBuffSide(cond, ctx);
    if (!judged.length) return null;
    if (!this.outOfBand(violations.length / judged.length, lo, hi, judging)) return null;
    // Above-only judging: an out-of-band miss rate implies at least one offending cast.
    const firstViolationS = violations[0];
    if (firstViolationS == null) return null;
    const relation = cond.require === 'inside' ? 'without' : 'during';
    return {
      severity, category: 'rule_violation',
      timestamp_s: round(firstViolationS, 3),
      label: `${cond.spell_name} ${relation} ${cond.buff_spell_name}`,
      message: `${violations.length} of ${judged.length} ${cond.spell_name} casts landed ${relation} ${cond.buff_spell_name}. Top raiders ${hi <= 0 ? 'never miss it' : `miss at most ${this.oneIn(hi)}`}.`,
      measured: { value: `${violations.length} / ${judged.length}`, unit: 'cast(s)' },
      details: remedy ? { remedy } : undefined,
      occurrences: this.castOutsideBuffOccurrences(cond, ctx, judged),
      occurrenceTarget: `${cond.buff_spell_name} ${cond.require === 'inside' ? 'up' : 'down'} ${hi <= 0 ? 'every cast' : `on all but ${this.oneIn(hi)}`}`,
    };
  }
}
