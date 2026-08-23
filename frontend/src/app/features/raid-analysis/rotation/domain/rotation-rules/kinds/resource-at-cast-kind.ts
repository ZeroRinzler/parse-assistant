import { Injectable } from '@angular/core';
import { AnalysisFinding } from '../../../../../../domain/analysis/analysis.models';
import { ResourceAtCastCondition, RuleSeverity } from '../../../../../../domain/rulebook/rulebook.models';
import { RESOURCE_ACTOR_SOURCE, ResourceRow, RuleContext } from '../rule-context-service';
import { RuleBand, RuleDomain, RuleJudging, RuleStream } from '../rule-kind';
import { BoundedPerCastKind } from '../bounded-per-cast-kind';

/** Only a cast that touches a pool reports it, so a cast that spends nothing reads a neighbour's snapshot back this far. */
const RESOURCE_SAMPLE_WINDOW_S = 6;

/** WCL reports mana as a five/six-digit pool - every other resource this kind judges tops out near 100 - so only mana renders as a percent; everything else reads as a raw count against its own cap. */
const RAW_COUNT_MAX_POOL = 200;

@Injectable({ providedIn: 'root' })
export class ResourceAtCastKind extends BoundedPerCastKind<ResourceAtCastCondition> {
  readonly kind = 'resource_at_cast';

  streams(): RuleStream[] {
    return [];
  }

  readonly pooling = 'instance';

  // Spending above a floor has a live far side: sitting at the cap is wasted generation. A ceiling rule has none - spending at empty costs nothing.

  judging(cond: ResourceAtCastCondition): RuleJudging {
    return { primary: cond.bound === 'min' ? 'below' : 'above', twoSided: cond.bound === 'min' };
  }

  // Declares no step on purpose: the real one is 1/max of the player's own pool, which bake cannot know, so tolerance carries up to one display step of slack rather than snapping to a cap the field cannot supply.

  domain(): RuleDomain | null {
    return { min: 0, max: 1 };
  }

  sample(cond: ResourceAtCastCondition, ctx: RuleContext): number[] {
    return this.resourceFractionPerCast(cond, ctx).map(entry => entry.frac);
  }

  applicable(cond: ResourceAtCastCondition, ctx: RuleContext): boolean {
    return this.resourceFractionPerCast(cond, ctx).length > 0;
  }

  label(cond: ResourceAtCastCondition): string {
    return `${cond.spell_name} at ${cond.resource_name}`;
  }

  private resourceAt(rows: readonly ResourceRow[], castS: number): { amount: number; max: number } | null {
    let latest: ResourceRow | undefined;
    for (const row of rows) {
      if (row[0] > castS) break;
      latest = row;
    }
    if (!latest || latest[0] < castS - RESOURCE_SAMPLE_WINDOW_S) return null;
    return { amount: latest[1], max: latest[2] };
  }

  /** A share of the pool's own cap, so one bench band stays meaningful across pools whose scales differ by orders of magnitude - the runtime side converts back to the player's own amount/max for display. */
  private resourceFractionPerCast(
    cond: ResourceAtCastCondition, ctx: RuleContext,
  ): { timeS: number; frac: number; amount: number; max: number }[] {
    const judged: { timeS: number; frac: number; amount: number; max: number }[] = [];
    for (const event of ctx.castEvents) {
      if (event.type !== 'cast' || event.abilityGameID !== cond.spell_id) continue;
      if (event.resourceActor != null && event.resourceActor !== RESOURCE_ACTOR_SOURCE) continue;
      const own = event.classResources?.find(resource => resource.type === cond.resource_type);
      const pool = own?.max
        ? { amount: own.amount, max: own.max }
        : this.resourceAt(ctx.resourcePool(cond.resource_type), event.atS);
      if (!pool) continue;
      judged.push({ timeS: event.atS, frac: pool.amount / pool.max, amount: pool.amount, max: pool.max });
    }
    return judged;
  }

  protected evaluateBanded(
    cond: ResourceAtCastCondition, ctx: RuleContext, band: RuleBand, judging: RuleJudging, severity: RuleSeverity, remedy?: string,
  ): AnalysisFinding | null {
    const judged = this.resourceFractionPerCast(cond, ctx);
    const firstJudged = judged[0];
    if (!firstJudged) return null;
    const max = firstJudged.max;
    const raw = max <= RAW_COUNT_MAX_POOL;
    return this.evaluateBoundedPerCast({
      values: judged.map(({ timeS, frac, amount }) => ({ timeS, value: raw ? amount : frac })),
      scale: raw ? this.rawCountScale(max) : this.PERCENT,
      subject: cond.spell_name,
      label: limit => `${cond.bound === 'min' ? 'below' : 'above'} ${limit} ${cond.resource_name}`,
      phrase: limit => `were spent ${cond.bound === 'min' ? 'below' : 'above'} ${limit} ${cond.resource_name}`,
      advice: limit => cond.bound === 'min' ? `Spend at ${limit} or more.` : `Spend at ${limit} or less.`,
      farLabel: limit => `above ${limit} ${cond.resource_name}`,
      farPhrase: limit => `were spent above ${limit} ${cond.resource_name}`,
      farAdvice: 'Spend before you cap.',
    }, band, judging, severity, remedy);
  }
}
