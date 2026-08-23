import { Injectable, inject } from '@angular/core';
import { AnalysisFinding } from '../../../../../../domain/analysis/analysis.models';
import { FillerBelowHealthCondition, RuleSeverity } from '../../../../../../domain/rulebook/rulebook.models';
import { TimedEvent } from '../../../../../../domain/analysis/wcl-projections-service';
import { HealthRow, RuleContext } from '../rule-context-service';
import { RuleBand, RuleDomain, RuleJudging, RuleStream } from '../rule-kind';
import { FillerKind, FillerSplit } from '../filler-kind';
import { WclProjectionsService } from '../../../../../../domain/analysis/wcl-projections-service';

/** Health is sampled on hits rather than casts, and falls fast in execute range, so a cast reads back only this far. */
const HEALTH_SAMPLE_WINDOW_S = 2;

@Injectable({ providedIn: 'root' })
export class FillerBelowHealthKind extends FillerKind<FillerBelowHealthCondition> {
  private readonly projections = inject(WclProjectionsService);

  readonly kind = 'filler_below_health';

  streams(): RuleStream[] {
    return ['damage', 'targetHealth'];
  }

  readonly pooling = 'parse';

  judging(): RuleJudging {
    return { primary: 'below', twoSided: false };
  }

  domain(): RuleDomain | null {
    return { min: 0, max: 1 };
  }

  sample(cond: FillerBelowHealthCondition, ctx: RuleContext): number[] {
    const share = this.fillerShare(this.fillersBelowHealth(cond, ctx));
    return share == null ? [] : [share];
  }

  applicable(cond: FillerBelowHealthCondition, ctx: RuleContext): boolean {
    return this.fillersBelowHealth(cond, ctx).total > 0;
  }

  label(cond: FillerBelowHealthCondition): string {
    return `${cond.spell_name} under ${cond.health_pct}% health`;
  }

  /** Health rides on damage rows rather than casts, so a cast reads the latest snapshot of THE ENEMY IT NAMED - a tick on a dying add otherwise licenses an execute against a full-health boss. */
  private targetHealthFracAt(ctx: RuleContext, cast: TimedEvent): number | null {
    const castS = cast.atS;
    const rows = ctx.targetHealth(this.projections.targetKey(cast));
    let latest: HealthRow | undefined;
    for (const row of rows) {
      if (row[0] > castS) break;
      latest = row;
    }
    if (!latest || latest[0] < castS - HEALTH_SAMPLE_WINDOW_S) return null;
    return latest[1];
  }

  private fillerBelowHealthTimesFor(cond: FillerBelowHealthCondition, ctx: RuleContext): (spellId: number) => number[] {
    const gate = cond.health_pct / 100;
    return spellId => ctx.castEvents
      .filter(event => {
        if (event.type !== 'cast' || event.abilityGameID !== spellId) return false;
        if (this.suspendedAt(cond.except_buff_spell_ids, ctx, event.atS)) return false;
        const frac = this.targetHealthFracAt(ctx, event);
        return frac != null && frac <= gate;
      })
      .map(event => event.atS);
  }

  private fillersBelowHealth(cond: FillerBelowHealthCondition, ctx: RuleContext): FillerSplit {
    return this.splitFillers(cond.spell_id, cond.alternative_spell_ids, this.fillerBelowHealthTimesFor(cond, ctx));
  }

  protected evaluateBanded(
    cond: FillerBelowHealthCondition, ctx: RuleContext, band: RuleBand, judging: RuleJudging, severity: RuleSeverity, remedy?: string,
  ): AnalysisFinding | null {
    const finding = this.fillerFinding(this.fillersBelowHealth(cond, ctx), band, judging, severity,
      cond.spell_name, `under ${cond.health_pct}% health`, remedy);
    if (!finding) return null;
    return {
      ...finding,
      occurrences: this.fillerOccurrences(
        cond.spell_id, cond.spell_name, cond.alternative_spell_ids, cond.alternative_spell_names,
        this.fillerBelowHealthTimesFor(cond, ctx),
      ),
      occurrenceTarget: `${this.PERCENT.format(this.bandLimits(this.PERCENT, band).lo)} or more ${cond.spell_name} under ${cond.health_pct}% health`,
    };
  }
}
