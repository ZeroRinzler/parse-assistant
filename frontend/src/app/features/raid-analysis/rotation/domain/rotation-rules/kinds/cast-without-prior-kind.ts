import { Injectable } from '@angular/core';
import { round } from '../../../../../../domain/analysis/analysis-math';
import { AnalysisFinding, FindingOccurrence } from '../../../../../../domain/analysis/analysis.models';
import { CastWithoutPriorCondition, RuleSeverity } from '../../../../../../domain/rulebook/rulebook.models';
import { CastTimes, RuleContext } from '../rule-context-service';
import { RuleBand, RuleDomain, RuleJudging, RuleKind, RuleStream } from '../rule-kind';

@Injectable({ providedIn: 'root' })
export class CastWithoutPriorKind extends RuleKind<CastWithoutPriorCondition> {
  readonly kind = 'cast_without_prior';

  streams(): RuleStream[] {
    return [];
  }

  readonly pooling = 'instance';

  judging(): RuleJudging {
    return { primary: 'above', twoSided: false };
  }

  domain(): RuleDomain | null {
    return { min: 0, max: null };
  }

  sample(cond: CastWithoutPriorCondition, ctx: RuleContext): number[] {
    return this.leadPerCast(cond, ctx.castTimes).filter((lead): lead is number => lead != null);
  }

  // An unpaired cast is the violation this kind is named for, but it has no lead to pool, so it reaches tolerance this way instead.

  override unmeasured(cond: CastWithoutPriorCondition, ctx: RuleContext): number {
    return this.leadPerCast(cond, ctx.castTimes).filter(lead => lead == null).length;
  }

  applicable(cond: CastWithoutPriorCondition, ctx: RuleContext): boolean {
    return this.castCount(ctx, cond.spell_id) > 0;
  }

  label(cond: CastWithoutPriorCondition): string {
    return `${cond.spell_name} with ${cond.required_spell_name}`;
  }

  /** The tightest lead each cast achieved on the required side, or null when a cast never paired at all. */
  private leadPerCast(cond: CastWithoutPriorCondition, castTimes: CastTimes): (number | null)[] {
    const position = cond.position ?? 'before';
    const required = castTimes[cond.required_spell_id] ?? [];
    return [...(castTimes[cond.spell_id] ?? [])].sort((a, b) => a - b).map(time => {
      const leads = required.map(rt => time - rt)
        .filter(lead => position === 'either' || (position === 'before' ? lead >= 0 : lead <= 0))
        .map(Math.abs);
      return leads.length ? Math.min(...leads) : null;
    });
  }

  private castWithoutPriorOccurrences(
    cond: CastWithoutPriorCondition, castTimes: CastTimes, hi: number,
  ): FindingOccurrence[] {
    const primary = [...(castTimes[cond.spell_id] ?? [])].sort((a, b) => a - b);
    const leads = this.leadPerCast(cond, castTimes);
    return this.sampleOccurrences(primary.map((time, i) => {
      const lead = leads[i];
      const ok = lead != null && lead <= hi;
      return {
        atS: round(time, 3), ok,
        label: lead == null ? 'none' : `${round(lead, 1)}s`,
        detail: lead == null
          ? `No ${cond.required_spell_name} paired with this cast.`
          : `${cond.required_spell_name} landed ${round(lead, 1)}s from this cast.`,
      };
    }));
  }

  protected evaluateBanded(
    cond: CastWithoutPriorCondition, ctx: RuleContext, band: RuleBand, judging: RuleJudging, severity: RuleSeverity, remedy?: string,
  ): AnalysisFinding | null {
    const { lo, hi } = this.bandLimits(this.SECONDS, band);
    const castTimes = ctx.castTimes;
    const primary = [...(castTimes[cond.spell_id] ?? [])].sort((a, b) => a - b);
    const leads = this.leadPerCast(cond, castTimes);
    const violations = primary.filter((_, i) => {
      const lead = leads[i];
      return lead == null || this.outOfBand(lead, lo, hi, judging);
    });
    if (!this.exceedsTolerance(violations.length, primary.length, band)) return null;
    const firstViolationS = violations[0];
    if (firstViolationS == null) return null;
    return {
      severity, category: 'rule_violation',
      timestamp_s: round(firstViolationS, 3),
      label: `${cond.spell_name} without ${cond.required_spell_name}`,
      message: `${violations.length} of ${primary.length} ${cond.spell_name} casts had no ${cond.required_spell_name} before them. Cast it within ${this.SECONDS.format(hi)} of ${cond.required_spell_name}.`,
      measured: { value: `${violations.length} / ${primary.length}`, unit: 'cast(s)' },
      details: remedy ? { remedy } : undefined,
      occurrences: this.castWithoutPriorOccurrences(cond, castTimes, hi),
      occurrenceTarget: `within ${this.SECONDS.format(hi)} of ${cond.required_spell_name}`,
    };
  }
}
