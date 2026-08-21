import { round } from '../../../../shared/analysis/analysis-math';
import { AnalysisFinding, FindingOccurrence } from '../../../../core/models/analysis.models';
import { RulebookRule, RuleCondition, RuleSeverity } from '../../../../core/models/rulebook.models';
import { RuleContext } from './rule-context';

/** Cap on a finding's occurrence strip - a fight can carry far more casts than a chip row should render. */
const MAX_OCCURRENCES = 24;

function evenSample<T>(items: T[], count: number): T[] {
  const step = items.length / count;
  const out: T[] = [];
  items.forEach((item, index) => {
    if (out.length < count && index >= Math.floor(out.length * step)) out.push(item);
  });
  return out;
}

/** Thins to at most MAX_OCCURRENCES without ever dropping a failing occurrence in favor of a passing one - a violation finding must keep showing its violations. */
export function sampleOccurrences(occurrences: FindingOccurrence[]): FindingOccurrence[] {
  if (occurrences.length <= MAX_OCCURRENCES) return occurrences;
  const bad = occurrences.filter(occ => !occ.ok);
  if (bad.length >= MAX_OCCURRENCES) return evenSample(bad, MAX_OCCURRENCES);
  const good = occurrences.filter(occ => occ.ok);
  const kept = new Set<FindingOccurrence>([...bad, ...evenSample(good, MAX_OCCURRENCES - bad.length)]);
  return occurrences.filter(occ => kept.has(occ));
}

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
type RulePooling = 'instance' | 'parse';

export function outOfBand(value: number, lo: number, hi: number, judging: RuleJudging): boolean {
  if (judging.twoSided) return value < lo || value > hi;
  return judging.primary === 'below' ? value < lo : value > hi;
}

export function exceedsTolerance(out: number, total: number, band: RuleBand): boolean {
  return out > 0 && out > total * band.tolerance;
}

export interface Scale {
  quantize: (value: number) => number;
  format: (value: number) => string;
  /** How the field's two edges read as one range, since a `/5` unit belongs on the range rather than on each end. */
  span: (lo: number, hi: number) => string;
}

/** Targets and stacks come in whole units, and a fractional bar donates a full unit of slack that fires the rule a unit late. */
export const WHOLE_STEPS: Scale = {
  quantize: Math.round, format: value => String(Math.round(value)),
  span: (lo, hi) => lo === hi ? String(lo) : `${lo}-${hi}`,
};

export const PERCENT: Scale = {
  quantize: value => Math.round(value * 100) / 100, format: value => `${Math.round(value * 100)}%`,
  span: (lo, hi) => lo === hi ? `${Math.round(lo * 100)}%` : `${Math.round(lo * 100)}-${Math.round(hi * 100)}%`,
};

/** A share already carried in percentage points rather than as a fraction. */
export const PERCENT_POINTS: Scale = {
  quantize: Math.round, format: value => `${Math.round(value)}%`,
  span: (lo, hi) => lo === hi ? `${Math.round(lo)}%` : `${Math.round(lo)}-${Math.round(hi)}%`,
};

export const SECONDS: Scale = {
  quantize: value => round(value, 1), format: value => `${round(value, 1)}s`,
  span: (lo, hi) => lo === hi ? `${round(lo, 1)}s` : `${round(lo, 1)}-${round(hi, 1)}s`,
};

export function rawCountScale(max: number): Scale {
  return {
    quantize: fraction => Math.round(fraction * max), format: value => `${Math.round(value)}/${max}`,
    span: (lo, hi) => lo === hi ? `${lo}/${max}` : `${lo}-${hi}/${max}`,
  };
}

/** The band's edges in the metric's display steps, so the number in the copy is the number that judged the instance. */
export function bandLimits(scale: Scale, band: RuleBand): { lo: number; hi: number } {
  return { lo: scale.quantize(band.lo), hi: scale.quantize(band.hi) };
}

/** A share as odds, since "1 in 10" lands faster than "10%" for a miss or waste rate. */
export function oneIn(share: number): string {
  return `1 in ${Math.max(2, Math.round(1 / share))}`;
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

/** One kind's facts in one block, so adding a kind is one edit rather than one per dispatch site. */
export interface KindSpec<C extends RuleCondition> {
  streams: (cond: C) => RuleStream[];
  pooling: RulePooling;
  /** The one declaration of which way this metric is judged: the evaluator is handed this, never its own copy. */
  judging: (cond: C) => RuleJudging;
  /** Null where the rulebook has not declared the bounds this kind needs, which drops the rule rather than reading unknown as unbounded. */
  domain: (cond: C) => RuleDomain | null;
  /** Every instance this parse measured, pooled across parses to build the band. Empty when the pull never produced one. */
  sample: (cond: C, ctx: RuleContext) => number[];
  unmeasured?: (cond: C, ctx: RuleContext) => number;
  evaluate: (
    cond: C, ctx: RuleContext, band: RuleBand | null, judging: RuleJudging, severity: RuleSeverity, remedy?: string,
  ) => AnalysisFinding | null;
  applicable: (cond: C, ctx: RuleContext) => boolean;
  label: (cond: C) => string;
}

export function withBand<C extends RuleCondition>(
  evaluate: (
    cond: C, ctx: RuleContext, band: RuleBand, judging: RuleJudging, severity: RuleSeverity, remedy?: string,
  ) => AnalysisFinding | null,
): KindSpec<C>['evaluate'] {
  return (cond, ctx, band, judging, severity, remedy) => band && evaluate(cond, ctx, band, judging, severity, remedy);
}
