import { quantile } from 'd3-array';
import { AnalysisFinding } from '../../../../core/models/analysis.models';
import { RulebookRule, RuleCondition, RuleSeverity } from '../../../../core/models/rulebook.models';
import { RuleContext } from './rule-context';
import {
  BenchedRule, RuleBand, RuleDomain, RuleJudging, RuleSample, RuleStream, outOfBand,
} from './engine-core';
import { specFor } from './registry';

/** Short chip label for a rulebook rule `type`, matching the tone of `CAT_LABEL`. */
export const RULE_TYPE_LABEL: Record<string, string> = {
  cooldown_pairing: 'pairing',
  cd_hold: 'cd hold',
  opener: 'opener',
  rotation: 'rotation',
  aoe_switch: 'aoe',
};

/** The pool's edges. A percentile of observed instances IS an observed instance, so a limit is always reachable. */
const BAND_LOW_Q = 0.1;
const BAND_HIGH_Q = 0.9;
/** Read at the same percentile as the edges: all but one top parse stays inside this share of out-of-band instances. */
const TOLERANCE_Q = 0.9;
/** Past this the field's own parses sit outside the band it defines more often than not, so there is no shared behaviour to judge. */
const MAX_TOLERANCE = 0.5;
/** Below this the pool is one parse's habit rather than the field's. */
export const MIN_MEASURED_PARSES = 5;
/** Under this a percentile only interpolates between two neighbours and names the second-worst parse, so the band falls back to the pool's own min/max - which every parse-pooled band does, capped at one value per top parse. */
const MIN_POOLED_INSTANCES = 20;

export function rulesNeed(rules: RulebookRule[], stream: RuleStream): boolean {
  return judgeableRules(rules).some(rule => specFor(rule.condition).streams(rule.condition).includes(stream));
}

/** A deployed rulebook file can still carry a rule with no condition, which the engine has nothing to judge. */
export function judgeableRules(rules: RulebookRule[]): (RulebookRule & { condition: RuleCondition })[] {
  return rules.filter((rule): rule is RulebookRule & { condition: RuleCondition } => rule.condition != null);
}

/** The one place a kind's judging is decided, so bake, runtime and specs cannot each answer it differently. */
export function ruleJudging(cond: RuleCondition): RuleJudging {
  return specFor(cond).judging(cond);
}

export function sampleRule(cond: RuleCondition, ctx: RuleContext): RuleSample {
  const spec = specFor(cond);
  return { values: spec.sample(cond, ctx), unmeasuredOut: spec.unmeasured?.(cond, ctx) ?? 0 };
}

export function ruleBand(cond: RuleCondition, perParse: RuleSample[]): {
  band: RuleBand | null; sample_count: number;
} {
  const spec = specFor(cond);
  const contributing = perParse.filter(sample => sample.values.length > 0);
  const pooled = contributing.flatMap(sample => sample.values).sort((a, b) => a - b);
  const counts = { sample_count: pooled.length };
  const domain = spec.domain(cond);
  // A domain the rulebook never declared is not an unbounded one; with no cap there is no far edge to judge against.
  if (domain == null || contributing.length < MIN_MEASURED_PARSES) return { band: null, ...counts };

  const judging = spec.judging(cond);
  const { lo, hi } = bandEdges(pooled);
  const snap = snapper(domain);
  const tolerance = spec.pooling === 'instance'
    ? outShareTolerance(perParse.filter(s => s.values.length + s.unmeasuredOut > 0), snap(lo), snap(hi), judging)
    : 0;
  const band: RuleBand = { lo, hi, tolerance };
  if (tolerance >= MAX_TOLERANCE || !bandCanFlag(domain, band, judging)) return { band: null, ...counts };
  return { band, ...counts };
}

/** A thick pool has a tail to read a percentile off; a thin one only has its own extremes, and reading p10 off ten points just names the second-worst parse. */
function bandEdges(pooled: number[]): { lo: number; hi: number } {
  if (pooled.length >= MIN_POOLED_INSTANCES) {
    return { lo: quantile(pooled, BAND_LOW_Q) ?? 0, hi: quantile(pooled, BAND_HIGH_Q) ?? 0 };
  }
  return { lo: pooled[0] ?? 0, hi: pooled[pooled.length - 1] ?? 0 };
}

/** The metric's display step, so every bake-side check judges the same edge the runtime's `Scale` rounds to. */
function snapper(domain: RuleDomain): (value: number) => number {
  const step = domain.step ?? 0;
  return step ? (value: number) => Math.round(value / step) * step : (value: number) => value;
}

/** Read over every instance the runtime judges, measured or not, so tolerance cannot be calibrated on a narrower population than it defends. */
function outShareTolerance(perParse: RuleSample[], lo: number, hi: number, judging: RuleJudging): number {
  const shares = perParse
    .map(({ values, unmeasuredOut }) => {
      const judged = values.length + unmeasuredOut;
      const out = values.filter(value => outOfBand(value, lo, hi, judging)).length + unmeasuredOut;
      return judged ? out / judged : 0;
    })
    .sort((a, b) => a - b);
  return quantile(shares, TOLERANCE_Q) ?? 0;
}

/** An edge with nothing past it in the metric's own domain would list every player on plan for a rule it never tested. Two-sided judging survives on either edge alone. */
function bandCanFlag(domain: RuleDomain, band: RuleBand, judging: RuleJudging): boolean {
  const snap = snapper(domain);
  const lowLive = snap(band.lo) > domain.min;
  const highLive = domain.max != null && snap(band.hi) < domain.max;
  if (judging.twoSided) return lowLive || highLive;
  return judging.primary === 'below' ? lowLive : domain.max == null || highLive;
}

export function benchedRules(
  benched: BenchedRule[],
): (BenchedRule & { rule: RulebookRule & { condition: RuleCondition }; band: RuleBand })[] {
  return benched.filter(
    (entry): entry is BenchedRule & { rule: RulebookRule & { condition: RuleCondition }; band: RuleBand } =>
      entry.rule.condition != null && entry.band != null,
  );
}

function evaluateCondition(
  cond: RuleCondition, ctx: RuleContext, band: RuleBand | null, severity: RuleSeverity, remedy?: string,
): AnalysisFinding | null {
  return specFor(cond).evaluate(cond, ctx, band, ruleJudging(cond), severity, remedy);
}

/** Whether the pull gave the player any chance to break the rule; without this a rule reads as followed on a fight it never came up in. */
export function ruleApplicable(cond: RuleCondition, ctx: RuleContext): boolean {
  return specFor(cond).applicable(cond, ctx);
}

export function evaluateRules(benched: BenchedRule[], ctx: RuleContext): AnalysisFinding[] {
  const findings: AnalysisFinding[] = [];
  for (const { rule, band } of benched) {
    const cond = rule.condition;
    // The gate rulesFollowed uses, so a rule the pull never tested lands in neither state instead of reading as broken.
    if (cond == null || !ruleApplicable(cond, ctx)) continue;
    const finding = evaluateCondition(cond, ctx, band, rule.severity, rule.action);
    // One authored name in both states, so a rule does not read as two different rules.
    if (finding) findings.push({ ...finding, rule_type: rule.type, label: rule.description });
  }
  return findings;
}

export function ruleLabel(cond: RuleCondition, description?: string): string {
  return description ?? specFor(cond).label(cond);
}

export function rulesFollowed(benched: BenchedRule[], ctx: RuleContext): string[] {
  const followed: string[] = [];
  for (const { rule, band } of benched) {
    const cond = rule.condition;
    if (cond == null || !ruleApplicable(cond, ctx)) continue;
    if (!evaluateCondition(cond, ctx, band, rule.severity)) {
      followed.push(ruleLabel(cond, rule.description));
    }
  }
  return followed;
}
