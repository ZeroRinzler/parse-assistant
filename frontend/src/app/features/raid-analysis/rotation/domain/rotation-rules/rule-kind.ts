import { inject } from '@angular/core';
import { round } from '../../../../../domain/analysis/analysis-math';
import { AnalysisFinding, FindingOccurrence } from '../../../../../domain/analysis/analysis.models';
import { RulebookRule, RuleCondition, RuleSeverity } from '../../../../../domain/rulebook/rulebook.models';
import { AuraWindowsService } from '../../../../../domain/analysis/aura-windows-service';
import { RuleContext } from './rule-context-service';

/** Cap on a finding's occurrence strip - a fight can carry far more casts than a chip row should render. */
const MAX_OCCURRENCES = 24;

/** The field's own range for a rule's measured quantity. Both edges are observed values, so a limit can never land where no player can reach it. */
export interface RuleBand {
  lo: number;
  hi: number;
  /** The share of its own instances all but the sloppiest top parse keeps outside [lo, hi], so the field's own spread is never itself a finding. */
  tolerance: number;
}

export interface BenchedRule {
  rule: RulebookRule;
  /** Null when the pool was too thin, the field too scattered, or the authored edge unviolatable, which drops the rule rather than judging against a guess. */
  band: RuleBand | null;
  sample_count: number;
}

export interface RuleJudging {
  primary: 'below' | 'above';
  /** True where the metric is a choice the player makes in both directions, so landing far outside either edge is a mistake. */
  twoSided: boolean;
}

/** Whether the parse contributes one value per occurrence or exactly one value for the whole pull. */
export type RulePooling = 'instance' | 'parse';

export interface Scale {
  quantize: (value: number) => number;
  format: (value: number) => string;
  /** How the field's two edges read as one range, since a `/5` unit belongs on the range rather than on each end. */
  span: (lo: number, hi: number) => string;
}

/** The optional event streams a rule reads beyond the always-fetched casts and buffs. `targetHealth` rides on `damage`, asking for its heavier resource-bearing form. */
export type RuleStream = 'enemyAuras' | 'damage' | 'targetHealth';

/** The measured quantity's own bounds and step, so an edge with no room past it is recognised as unviolatable. `max: null` is a genuinely unbounded metric. */
export interface RuleDomain {
  min: number;
  max: number | null;
  step?: number;
}

export interface RuleSample {
  values: number[];
  /** Instances the runtime counts as violations but that carry no measurable value, so tolerance is read off the population the runtime actually judges. */
  unmeasuredOut: number;
}

/** One kind's facts in one class, so adding a kind is one subclass rather than one edit per dispatch site. */
export abstract class RuleKind<C extends RuleCondition> {
  protected readonly auraWindows = inject(AuraWindowsService);

  abstract readonly kind: C['kind'];
  abstract readonly pooling: RulePooling;
  abstract streams(cond: C): RuleStream[];
  /** The one declaration of which way this metric is judged: the evaluator is handed this, never its own copy. */
  abstract judging(cond: C): RuleJudging;
  /** Null where the rulebook has not declared the bounds this kind needs, which drops the rule rather than reading unknown as unbounded. */
  abstract domain(cond: C): RuleDomain | null;
  /** Every instance this parse measured, pooled across parses to build the band. Empty when the pull never produced one. */
  abstract sample(cond: C, ctx: RuleContext): number[];
  abstract applicable(cond: C, ctx: RuleContext): boolean;
  abstract label(cond: C): string;

  unmeasured(_cond: C, _ctx: RuleContext): number {
    return 0;
  }

  evaluate(
    cond: C, ctx: RuleContext, band: RuleBand | null, judging: RuleJudging, severity: RuleSeverity, remedy?: string,
  ): AnalysisFinding | null {
    return band && this.evaluateBanded(cond, ctx, band, judging, severity, remedy);
  }

  protected abstract evaluateBanded(
    cond: C, ctx: RuleContext, band: RuleBand, judging: RuleJudging, severity: RuleSeverity, remedy?: string,
  ): AnalysisFinding | null;

  outOfBand(value: number, lo: number, hi: number, judging: RuleJudging): boolean {
    if (judging.twoSided) return value < lo || value > hi;
    return judging.primary === 'below' ? value < lo : value > hi;
  }

  exceedsTolerance(out: number, total: number, band: RuleBand): boolean {
    return out > 0 && out > total * band.tolerance;
  }

  /** Thins to at most MAX_OCCURRENCES without ever dropping a failing occurrence in favor of a passing one - a violation finding must keep showing its violations. */
  protected sampleOccurrences(occurrences: FindingOccurrence[]): FindingOccurrence[] {
    if (occurrences.length <= MAX_OCCURRENCES) return occurrences;
    const bad = occurrences.filter(occ => !occ.ok);
    if (bad.length >= MAX_OCCURRENCES) return this.evenSample(bad, MAX_OCCURRENCES);
    const good = occurrences.filter(occ => occ.ok);
    const kept = new Set<FindingOccurrence>([...bad, ...this.evenSample(good, MAX_OCCURRENCES - bad.length)]);
    return occurrences.filter(occ => kept.has(occ));
  }

  private evenSample<T>(items: T[], count: number): T[] {
    const step = items.length / count;
    const out: T[] = [];
    items.forEach((item, index) => {
      if (out.length < count && index >= Math.floor(out.length * step)) out.push(item);
    });
    return out;
  }

  /** The band's edges in the metric's display steps, so the number in the copy is the number that judged the instance. */
  protected bandLimits(scale: Scale, band: RuleBand): { lo: number; hi: number } {
    return { lo: scale.quantize(band.lo), hi: scale.quantize(band.hi) };
  }

  /** A share as odds, since "1 in 10" lands faster than "10%" for a miss or waste rate. */
  protected oneIn(share: number): string {
    return `1 in ${Math.max(2, Math.round(1 / share))}`;
  }

  protected castCount(ctx: RuleContext, spellId: number): number {
    return ctx.castTimes[spellId]?.length ?? 0;
  }

  /** A state the rule agreed not to judge under, so a window the sources say to press the other button in is not counted against the player. */
  protected suspendedAt(exceptIds: number[] | undefined, ctx: RuleContext, timeS: number): boolean {
    return (exceptIds ?? []).some(spellId => this.auraWindows.auraUpAt(ctx.selfAuras, spellId, timeS));
  }

  /** Targets and stacks come in whole units, and a fractional bar donates a full unit of slack that fires the rule a unit late. */
  protected readonly WHOLE_STEPS: Scale = {
    quantize: Math.round, format: value => String(Math.round(value)),
    span: (lo, hi) => lo === hi ? String(lo) : `${lo}-${hi}`,
  };

  protected readonly PERCENT: Scale = {
    quantize: value => Math.round(value * 100) / 100, format: value => `${Math.round(value * 100)}%`,
    span: (lo, hi) => lo === hi ? `${Math.round(lo * 100)}%` : `${Math.round(lo * 100)}-${Math.round(hi * 100)}%`,
  };

  /** A share already carried in percentage points rather than as a fraction. */
  protected readonly PERCENT_POINTS: Scale = {
    quantize: Math.round, format: value => `${Math.round(value)}%`,
    span: (lo, hi) => lo === hi ? `${Math.round(lo)}%` : `${Math.round(lo)}-${Math.round(hi)}%`,
  };

  protected readonly SECONDS: Scale = {
    quantize: value => round(value, 1), format: value => `${round(value, 1)}s`,
    span: (lo, hi) => lo === hi ? `${round(lo, 1)}s` : `${round(lo, 1)}-${round(hi, 1)}s`,
  };

  protected rawCountScale(max: number): Scale {
    return {
      quantize: fraction => Math.round(fraction * max), format: value => `${Math.round(value)}/${max}`,
      span: (lo, hi) => lo === hi ? `${lo}/${max}` : `${lo}-${hi}/${max}`,
    };
  }
}
