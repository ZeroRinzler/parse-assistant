import { Injectable } from '@angular/core';
import { round } from '../../../../../../domain/analysis/analysis-math';
import { AnalysisFinding, FindingOccurrence } from '../../../../../../domain/analysis/analysis.models';
import { OpeningSequenceCondition, RuleSeverity } from '../../../../../../domain/rulebook/rulebook.models';
import { RuleContext } from '../rule-context-service';
import { RuleBand, RuleDomain, RuleJudging, RuleKind, RuleStream } from '../rule-kind';

interface OpenerStepResult { ok: boolean; atS?: number; name: string; }

@Injectable({ providedIn: 'root' })
export class OpeningSequenceKind extends RuleKind<OpeningSequenceCondition> {
  readonly kind = 'opening_sequence';

  streams(): RuleStream[] {
    return [];
  }

  readonly pooling = 'parse';

  judging(): RuleJudging {
    return { primary: 'above', twoSided: false };
  }

  domain(): RuleDomain | null {
    return { min: 0, max: null };
  }

  // Measured against the whole pull, since the window being derived cannot gate its own measurement.

  sample(cond: OpeningSequenceCondition, ctx: RuleContext): number[] {
    const completedS = this.openerProgress(cond, ctx, ctx.fightDurationS)?.completedS;
    return completedS == null ? [] : [completedS];
  }

  applicable(cond: OpeningSequenceCondition, ctx: RuleContext): boolean {
    return cond.spell_ids.some(spellId => this.castCount(ctx, spellId) > 0);
  }

  label(cond: OpeningSequenceCondition): string {
    return `Opener: ${cond.spell_names.join(' > ')}`;
  }

  private openerProgress(
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

  /** Every step's own result, unlike `openerProgress` which stops walking at the first miss - a later step can still land. */
  private openerSteps(cond: OpeningSequenceCondition, ctx: RuleContext, pullS: number, deadlineS: number): OpenerStepResult[] {
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

  private openingSequenceOccurrences(
    cond: OpeningSequenceCondition, ctx: RuleContext, pullS: number, deadlineS: number,
  ): FindingOccurrence[] {
    return this.openerSteps(cond, ctx, pullS, deadlineS).map(step =>
      step.ok
        ? { atS: step.atS, ok: true, label: step.name, detail: `${step.name} landed on time in its slot.` }
        : { ok: false, label: step.name, note: 'not reached', detail: `${step.name} was never reached in the opener window.` });
  }

  protected evaluateBanded(
    cond: OpeningSequenceCondition, ctx: RuleContext, band: RuleBand, _judging: RuleJudging, severity: RuleSeverity, remedy?: string,
  ): AnalysisFinding | null {
    const hi = this.bandLimits(this.SECONDS, band).hi;
    const progress = this.openerProgress(cond, ctx, hi);
    if (!progress || progress.completedS != null) return null;
    return {
      severity, category: 'rule_violation',
      timestamp_s: round(progress.pullS, 3),
      label: `Opener: ${cond.spell_names.join(' > ')}`,
      message: `Your opener got ${progress.matched} of ${cond.spell_ids.length} steps out. Top raiders finish all ${cond.spell_ids.length} within ${this.SECONDS.format(hi)}.`,
      measured: { value: `${progress.matched} / ${cond.spell_ids.length}`, unit: 'step(s)' },
      details: remedy ? { remedy } : undefined,
      occurrences: this.openingSequenceOccurrences(cond, ctx, progress.pullS, progress.pullS + hi),
      occurrenceTarget: `expected order: ${cond.spell_names.join(' > ')}`,
    };
  }
}
