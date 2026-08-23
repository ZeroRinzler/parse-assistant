import { Injectable } from '@angular/core';
import { AnalysisFinding } from '../../../../../../domain/analysis/analysis.models';
import { FillerInBuffCondition, RuleSeverity } from '../../../../../../domain/rulebook/rulebook.models';
import { RuleContext } from '../rule-context-service';
import { RuleBand, RuleDomain, RuleJudging, RuleStream } from '../rule-kind';
import { FillerKind, FillerSplit } from '../filler-kind';

@Injectable({ providedIn: 'root' })
export class FillerInBuffKind extends FillerKind<FillerInBuffCondition> {
  readonly kind = 'filler_in_buff';

  streams(): RuleStream[] {
    return [];
  }

  readonly pooling = 'parse';

  judging(): RuleJudging {
    return { primary: 'below', twoSided: false };
  }

  domain(): RuleDomain | null {
    return { min: 0, max: 1 };
  }

  sample(cond: FillerInBuffCondition, ctx: RuleContext): number[] {
    const share = this.fillerShare(this.fillerCastsInBuff(cond, ctx));
    return share == null ? [] : [share];
  }

  applicable(cond: FillerInBuffCondition, ctx: RuleContext): boolean {
    return this.fillerCastsInBuff(cond, ctx).total > 0;
  }

  label(cond: FillerInBuffCondition): string {
    return `${cond.spell_name} in ${cond.buff_spell_name}`;
  }

  private fillerInBuffTimesFor(cond: FillerInBuffCondition, ctx: RuleContext): (spellId: number) => number[] {
    return spellId => (ctx.castTimes[spellId] ?? []).filter(time =>
      this.auraWindows.auraAlreadyUpAt(ctx.selfAuras, cond.buff_spell_id, time)
      && !this.suspendedAt(cond.except_buff_spell_ids, ctx, time));
  }

  private fillerCastsInBuff(cond: FillerInBuffCondition, ctx: RuleContext): FillerSplit {
    return this.splitFillers(cond.spell_id, cond.alternative_spell_ids, this.fillerInBuffTimesFor(cond, ctx));
  }

  protected evaluateBanded(
    cond: FillerInBuffCondition, ctx: RuleContext, band: RuleBand, judging: RuleJudging, severity: RuleSeverity, remedy?: string,
  ): AnalysisFinding | null {
    const finding = this.fillerFinding(this.fillerCastsInBuff(cond, ctx), band, judging, severity,
      cond.spell_name, `during ${cond.buff_spell_name}`, remedy);
    if (!finding) return null;
    return {
      ...finding,
      occurrences: this.fillerOccurrences(
        cond.spell_id, cond.spell_name, cond.alternative_spell_ids, cond.alternative_spell_names,
        this.fillerInBuffTimesFor(cond, ctx),
      ),
      occurrenceTarget: `${this.PERCENT.format(this.bandLimits(this.PERCENT, band).lo)} or more ${cond.spell_name} during ${cond.buff_spell_name}`,
    };
  }
}
