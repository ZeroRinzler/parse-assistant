// Separate from rotation.service.ts so the ingest transform measures top parses with the same code the runtime judges the player with.
import { median, quantile } from 'd3-array';
import { getOrInsert, round } from '../../../shared/analysis/analysis-math';
import { AnalysisFinding, FindingOccurrence } from '../../../core/models/analysis.models';
import {
  RulebookRule, RuleCondition,
  CastWithoutPriorCondition, HoldCooldownForAnchorCondition, CastOutsideBuffCondition,
  AuraUptimeBelowCondition, OpeningSequenceCondition,
  CastAtTargetCountCondition, ResourceAtCastCondition, ProcWastedCondition, FillerInBuffCondition,
  SpendAtStacksCondition, AuraClippedCondition, FillerBelowHealthCondition,
} from '../../../core/models/rulebook.models';
import { TimedEvent, targetKey } from '../../../shared/analysis/wcl-projections';
import {
  AuraWindows, AuraSpan, AuraSpansByTarget, StackTimeline,
  buildAuraWindows, buildStackTimeline, buildAuraSpansByTarget,
  auraUpAt, auraAlreadyUpAt, stacksAt, auraUptimePct,
} from '../../../shared/analysis/aura-windows';

export type Severity = AnalysisFinding['severity'];

/** Enemies damaged this soon after a cast count as engaged for it; an AoE ability lands well inside a GCD or two. */
const TARGET_COUNT_WINDOW_S = 3;

/** WCL flattens one actor's pools onto the event; 1 means they belong to the caster. */
const RESOURCE_ACTOR_SOURCE = 1;

/** The other half of the same field: 2 means the snapshot describes whoever was hit. */
const RESOURCE_ACTOR_TARGET = 2;

/** Health is sampled on hits rather than casts, and falls fast in execute range, so a cast reads back only this far. */
const HEALTH_SAMPLE_WINDOW_S = 2;

/** Only a cast that touches a pool reports it, so a cast that spends nothing reads a neighbour's snapshot back this far. */
const RESOURCE_SAMPLE_WINDOW_S = 6;

/** A re-application this soon AFTER a cast is that cast landing: measured deltas run 0-28ms, so this covers projectile flight without reaching the next proc. */
const HARD_CAST_WINDOW_S = 0.25;

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
function sampleOccurrences(occurrences: FindingOccurrence[]): FindingOccurrence[] {
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

export interface BenchedRule {
  rule: RulebookRule;
  /** Null when the pool was too thin, the field too scattered, or the authored edge unviolatable, which drops the rule rather than judging against a guess. */
  band: RuleBand | null;
  sample_count: number;
}

type CastTimes = Record<number, number[]>;

function buildCastTimes(casts: TimedEvent[]): CastTimes {
  const castTimes: CastTimes = {};
  for (const cast of casts) {
    if (cast.type === 'cast' && cast.abilityGameID) {
      (castTimes[cast.abilityGameID] ??= []).push(cast.atS);
    }
  }
  return castTimes;
}

/** Damage rows as `[atS, targetKey]`, time-ordered so a window is a slice rather than a scan. */
type DamageRow = [number, string];

/** One enemy's health as `[atS, share of max]`, time-ordered. */
type HealthRow = [number, number];

/** One cast's pool as `[atS, amount the cast left behind, max]`, time-ordered. */
type ResourceRow = [number, number, number];

export interface RuleContext {
  castTimes: CastTimes;
  castEvents: TimedEvent[];
  fightDurationS: number;
  selfAuras: AuraWindows;
  targetAuras: AuraWindows;
  /** Called rather than read: each builds on first use, and only for the one aura the rule names. */
  stacks: (spellId: number) => StackTimeline;
  selfSpans: (spellId: number) => AuraSpansByTarget;
  targetSpans: (spellId: number) => AuraSpansByTarget;
  damageIndex: () => readonly DamageRow[];
  targetHealth: (key: string) => readonly HealthRow[];
  resourcePool: (resourceType: number) => readonly ResourceRow[];
}

/** Built on first call and kept, so a stream no rulebook asks about costs nothing. */
function lazy<T extends object>(build: () => T): () => T {
  let value: T | undefined;
  return () => (value ??= build());
}

function perId<T extends object>(build: (id: number) => T): (id: number) => T {
  const cache = new Map<number, T>();
  return id => getOrInsert(cache, id, () => build(id));
}

function buildDamageIndex(damage: TimedEvent[]): DamageRow[] {
  return damage.map((event): DamageRow => [event.atS, targetKey(event)]).sort((a, b) => a[0] - b[0]);
}

/** `amount` is pre-cost, so the pool a cast leaves behind is what the next cast starts from; between the two only generation can raise it, which keeps an overcap read conservative. */
function buildResourceIndex(casts: TimedEvent[], resourceType: number): ResourceRow[] {
  const rows: ResourceRow[] = [];
  for (const event of casts) {
    if (event.type !== 'cast') continue;
    if (event.resourceActor != null && event.resourceActor !== RESOURCE_ACTOR_SOURCE) continue;
    const pool = event.classResources?.find(resource => resource.type === resourceType);
    if (!pool?.max) continue;
    rows.push([event.atS, Math.max(0, pool.amount - (pool.cost ?? 0)), pool.max]);
  }
  return rows.sort((a, b) => a[0] - b[0]);
}

/** Only the resource-bearing rows carry health, and only for whoever was hit. */
function buildHealthIndex(damage: TimedEvent[]): Map<string, HealthRow[]> {
  const index = new Map<string, HealthRow[]>();
  for (const event of damage) {
    if (event.resourceActor !== RESOURCE_ACTOR_TARGET || event.hitPoints == null || !event.maxHitPoints) continue;
    getOrInsert(index, targetKey(event), (): HealthRow[] => []).push([event.atS, event.hitPoints / event.maxHitPoints]);
  }
  for (const rows of index.values()) rows.sort((a, b) => a[0] - b[0]);
  return index;
}

export interface RuleInputs {
  casts: TimedEvent[];
  buffs: TimedEvent[];
  debuffs: TimedEvent[];
  damage: TimedEvent[];
  fightDurationS: number;
}

export function buildRuleContext(input: RuleInputs): RuleContext {
  const { casts, buffs, debuffs, damage, fightDurationS } = input;
  const health = lazy(() => buildHealthIndex(damage));
  return {
    castTimes: buildCastTimes(casts),
    castEvents: casts,
    fightDurationS,
    selfAuras: buildAuraWindows(buffs),
    targetAuras: buildAuraWindows(debuffs),
    stacks: perId(spellId => buildStackTimeline(buffs, spellId)),
    selfSpans: perId(spellId => buildAuraSpansByTarget(buffs, spellId)),
    targetSpans: perId(spellId => buildAuraSpansByTarget(debuffs, spellId)),
    damageIndex: lazy(() => buildDamageIndex(damage)),
    targetHealth: key => health().get(key) ?? [],
    resourcePool: perId(resourceType => buildResourceIndex(casts, resourceType)),
  };
}

export interface RuleJudging {
  primary: 'below' | 'above';
  /** True where the metric is a choice the player makes in both directions, so landing far outside either edge is a mistake. */
  twoSided: boolean;
}

/** Whether the parse contributes one value per occurrence or exactly one value for the whole pull. */
type RulePooling = 'instance' | 'parse';

function outOfBand(value: number, lo: number, hi: number, judging: RuleJudging): boolean {
  if (judging.twoSided) return value < lo || value > hi;
  return judging.primary === 'below' ? value < lo : value > hi;
}

function exceedsTolerance(out: number, total: number, band: RuleBand): boolean {
  return out > 0 && out > total * band.tolerance;
}

interface Scale {
  quantize: (value: number) => number;
  format: (value: number) => string;
  /** How the field's two edges read as one range, since a `/5` unit belongs on the range rather than on each end. */
  span: (lo: number, hi: number) => string;
}

/** Targets and stacks come in whole units, and a fractional bar donates a full unit of slack that fires the rule a unit late. */
const WHOLE_STEPS: Scale = {
  quantize: Math.round, format: value => String(Math.round(value)),
  span: (lo, hi) => lo === hi ? String(lo) : `${lo}-${hi}`,
};

const PERCENT: Scale = {
  quantize: value => Math.round(value * 100) / 100, format: value => `${Math.round(value * 100)}%`,
  span: (lo, hi) => lo === hi ? `${Math.round(lo * 100)}%` : `${Math.round(lo * 100)}-${Math.round(hi * 100)}%`,
};

/** A share already carried in percentage points rather than as a fraction. */
const PERCENT_POINTS: Scale = {
  quantize: Math.round, format: value => `${Math.round(value)}%`,
  span: (lo, hi) => lo === hi ? `${Math.round(lo)}%` : `${Math.round(lo)}-${Math.round(hi)}%`,
};

const SECONDS: Scale = {
  quantize: value => round(value, 1), format: value => `${round(value, 1)}s`,
  span: (lo, hi) => lo === hi ? `${round(lo, 1)}s` : `${round(lo, 1)}-${round(hi, 1)}s`,
};

/** The band's edges in the metric's display steps, so the number in the copy is the number that judged the instance. */
function bandLimits(scale: Scale, band: RuleBand): { lo: number; hi: number } {
  return { lo: scale.quantize(band.lo), hi: scale.quantize(band.hi) };
}

/** A share as odds, since "1 in 10" lands faster than "10%" for a miss or waste rate. */
function oneIn(share: number): string {
  return `1 in ${Math.max(2, Math.round(1 / share))}`;
}

function castCount(ctx: RuleContext, spellId: number): number {
  return ctx.castTimes[spellId]?.length ?? 0;
}

/** The tightest lead each cast achieved on the required side, or null when a cast never paired at all. */
function leadPerCast(cond: CastWithoutPriorCondition, castTimes: CastTimes): (number | null)[] {
  const position = cond.position ?? 'before';
  const required = castTimes[cond.required_spell_id] ?? [];
  return [...(castTimes[cond.spell_id] ?? [])].sort((a, b) => a - b).map(time => {
    const leads = required.map(rt => time - rt)
      .filter(lead => position === 'either' || (position === 'before' ? lead >= 0 : lead <= 0))
      .map(Math.abs);
    return leads.length ? Math.min(...leads) : null;
  });
}

function castWithoutPriorOccurrences(
  cond: CastWithoutPriorCondition, castTimes: CastTimes, hi: number,
): FindingOccurrence[] {
  const primary = [...(castTimes[cond.spell_id] ?? [])].sort((a, b) => a - b);
  const leads = leadPerCast(cond, castTimes);
  return sampleOccurrences(primary.map((time, i) => {
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

export function evaluateCastWithoutPrior(
  cond: CastWithoutPriorCondition, ctx: RuleContext, band: RuleBand, judging: RuleJudging, severity: Severity, remedy?: string,
): AnalysisFinding | null {
  const { lo, hi } = bandLimits(SECONDS, band);
  const castTimes = ctx.castTimes;
  const primary = [...(castTimes[cond.spell_id] ?? [])].sort((a, b) => a - b);
  const leads = leadPerCast(cond, castTimes);
  const violations = primary.filter((_, i) => {
    const lead = leads[i];
    return lead == null || outOfBand(lead, lo, hi, judging);
  });
  if (!exceedsTolerance(violations.length, primary.length, band)) return null;
  const firstViolationS = violations[0];
  if (firstViolationS == null) return null;
  return {
    severity, category: 'rule_violation',
    timestamp_s: round(firstViolationS, 3),
    label: `${cond.spell_name} without ${cond.required_spell_name}`,
    message: `${violations.length} of ${primary.length} ${cond.spell_name} casts had no ${cond.required_spell_name} before them. Cast it within ${SECONDS.format(hi)} of ${cond.required_spell_name}.`,
    measured: { value: `${violations.length} / ${primary.length}`, unit: 'cast(s)' },
    details: remedy ? { remedy } : undefined,
    occurrences: castWithoutPriorOccurrences(cond, castTimes, hi),
    occurrenceTarget: `within ${SECONDS.format(hi)} of ${cond.required_spell_name}`,
  };
}

/** Non-opener anchor casts: the first is nothing to have held for. */
function holdAnchors(cond: HoldCooldownForAnchorCondition, castTimes: CastTimes): number[] {
  return [...(castTimes[cond.anchor_spell_id] ?? [])].sort((a, b) => a - b).slice(1);
}

/** Gap from each judged cast to the anchor it was spent before, so the sample, the count and the chips all read one definition. */
function gapToNextAnchor(
  cond: HoldCooldownForAnchorCondition, ctx: RuleContext,
): { timeS: number; spellName: string; gapS: number }[] {
  const anchorTimes = holdAnchors(cond, ctx.castTimes);
  return cond.spell_ids.flatMap((spellId, i) => {
    const spellName = cond.spell_names[i] ?? String(spellId);
    return (ctx.castTimes[spellId] ?? []).flatMap(castTime => {
      const nextAnchor = anchorTimes.filter(anchorTime => anchorTime > castTime).sort((a, b) => a - b)[0];
      return nextAnchor != null ? [{ timeS: castTime, spellName, gapS: nextAnchor - castTime }] : [];
    });
  }).sort((a, b) => a.timeS - b.timeS);
}

function holdForAnchorOccurrences(
  cond: HoldCooldownForAnchorCondition, anchorTimes: number[],
  judged: { timeS: number; spellName: string; gapS: number }[], lo: number,
): FindingOccurrence[] {
  const chips: FindingOccurrence[] = anchorTimes.map(anchorTime => ({
    atS: round(anchorTime, 3), ok: true, label: cond.anchor_spell_name, marker: true,
    detail: `${cond.anchor_spell_name} cast here.`,
  }));
  chips.push(...judged.map(({ timeS, spellName, gapS }): FindingOccurrence => ({
    atS: round(timeS, 3), ok: gapS >= lo, label: SECONDS.format(gapS),
    detail: `${spellName} cast ${SECONDS.format(gapS)} before ${cond.anchor_spell_name}.`,
  })));
  chips.sort((a, b) => (a.atS ?? 0) - (b.atS ?? 0));
  return sampleOccurrences(chips);
}

export function evaluateHoldForAnchor(
  cond: HoldCooldownForAnchorCondition, ctx: RuleContext, band: RuleBand, judging: RuleJudging, severity: Severity, remedy?: string,
): AnalysisFinding | null {
  const { lo, hi } = bandLimits(SECONDS, band);
  const anchorTimes = holdAnchors(cond, ctx.castTimes);
  const judged = gapToNextAnchor(cond, ctx);
  const violations = judged.filter(entry => outOfBand(entry.gapS, lo, hi, judging));
  if (!exceedsTolerance(violations.length, judged.length, band)) return null;
  const firstViolation = violations[0];
  if (firstViolation == null) return null;
  const spellNames = [...new Set(violations.map(entry => entry.spellName))].join('/');
  return {
    severity, category: 'rule_violation',
    timestamp_s: round(firstViolation.timeS, 3),
    label: `${spellNames} held before ${cond.anchor_spell_name}`,
    message: `${spellNames} was used right before ${cond.anchor_spell_name} ${violations.length} of ${judged.length} times. Save it when ${cond.anchor_spell_name} is within ${SECONDS.format(lo)}.`,
    measured: { value: `${violations.length} / ${judged.length}`, unit: 'charge(s)' },
    details: remedy ? { remedy } : undefined,
    occurrences: holdForAnchorOccurrences(cond, anchorTimes, judged, lo),
    occurrenceTarget: `saved when ${cond.anchor_spell_name} is within ${SECONDS.format(lo)}`,
  };
}

function castOutsideBuffOccurrences(cond: CastOutsideBuffCondition, ctx: RuleContext, primary: number[]): FindingOccurrence[] {
  return sampleOccurrences(primary.map(time => {
    const up = auraUpAt(ctx.selfAuras, cond.buff_spell_id, time);
    return {
      atS: round(time, 3), ok: up === (cond.require === 'inside'), label: up ? 'up' : 'down',
      detail: `${cond.buff_spell_name} was ${up ? 'up' : 'down'} at this cast.`,
    };
  }));
}

/** One split feeds both the count in the sentence and the share judged against the bar, so the two cannot disagree. */
function castsOffBuffSide(
  cond: CastOutsideBuffCondition, ctx: RuleContext,
): { judged: number[]; violations: number[] } {
  const judged = [...(ctx.castTimes[cond.spell_id] ?? [])].sort((a, b) => a - b);
  const violations = judged.filter(time =>
    auraUpAt(ctx.selfAuras, cond.buff_spell_id, time) !== (cond.require === 'inside'));
  return { judged, violations };
}

function offSideShare(cond: CastOutsideBuffCondition, ctx: RuleContext): number | null {
  const { judged, violations } = castsOffBuffSide(cond, ctx);
  return judged.length ? violations.length / judged.length : null;
}

export function evaluateCastOutsideBuff(
  cond: CastOutsideBuffCondition, ctx: RuleContext, band: RuleBand, judging: RuleJudging, severity: Severity, remedy?: string,
): AnalysisFinding | null {
  const { lo, hi } = bandLimits(PERCENT, band);
  const { judged, violations } = castsOffBuffSide(cond, ctx);
  if (!judged.length) return null;
  if (!outOfBand(violations.length / judged.length, lo, hi, judging)) return null;
  // Above-only judging: an out-of-band miss rate implies at least one offending cast.
  const firstViolationS = violations[0];
  if (firstViolationS == null) return null;
  const relation = cond.require === 'inside' ? 'without' : 'during';
  return {
    severity, category: 'rule_violation',
    timestamp_s: round(firstViolationS, 3),
    label: `${cond.spell_name} ${relation} ${cond.buff_spell_name}`,
    message: `${violations.length} of ${judged.length} ${cond.spell_name} casts landed ${relation} ${cond.buff_spell_name}. Top raiders ${hi <= 0 ? 'never miss it' : `miss at most ${oneIn(hi)}`}.`,
    measured: { value: `${violations.length} / ${judged.length}`, unit: 'cast(s)' },
    details: remedy ? { remedy } : undefined,
    occurrences: castOutsideBuffOccurrences(cond, ctx, judged),
    occurrenceTarget: `${cond.buff_spell_name} ${cond.require === 'inside' ? 'up' : 'down'} ${hi <= 0 ? 'every cast' : `on all but ${oneIn(hi)}`}`,
  };
}

function uptimePct(cond: AuraUptimeBelowCondition, ctx: RuleContext): number {
  const windows = cond.on === 'target' ? ctx.targetAuras : ctx.selfAuras;
  return auraUptimePct(windows, cond.aura_spell_id, ctx.fightDurationS);
}

/** Overlapping spans merged (a multi-target debuff reads as "up somewhere"), clipped to `[0, boundS]`. */
function mergedUpSpans(windows: AuraWindows, spellId: number, boundS: number): [number, number][] {
  const spans = (windows.get(spellId) ?? [])
    .map(([start, end]): [number, number] => [Math.max(0, start), Math.min(boundS, end ?? boundS)])
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [start, end] of spans) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

/** Longest gaps in a merged coverage timeline, since those - not uniform drift - are what a maintain miss usually is. */
const MAX_UPTIME_GAPS = 3;

/** Below this, a gap is travel time or event-ordering noise rather than a missed refresh - and would render as a nonsensical "0s" chip anyway. */
const MIN_UPTIME_GAP_S = 1;

function uptimeGaps(merged: [number, number][], boundS: number): [number, number][] {
  const gaps: [number, number][] = [];
  let cursor = 0;
  for (const [start, end] of merged) {
    if (start > cursor) gaps.push([cursor, start]);
    cursor = Math.max(cursor, end);
  }
  if (cursor < boundS) gaps.push([cursor, boundS]);
  return gaps
    .filter(([start, end]) => end - start >= MIN_UPTIME_GAP_S)
    .sort((a, b) => (b[1] - b[0]) - (a[1] - a[0])).slice(0, MAX_UPTIME_GAPS).sort((a, b) => a[0] - b[0]);
}

export function evaluateAuraUptimeBelow(
  cond: AuraUptimeBelowCondition, ctx: RuleContext, band: RuleBand, judging: RuleJudging, severity: Severity, remedy?: string,
): AnalysisFinding | null {
  const { lo, hi } = bandLimits(PERCENT_POINTS, band);
  const pct = uptimePct(cond, ctx);
  // Zero uptime reads as a build that skips the aura rather than a mistake, which the app does not guess at.
  if (pct <= 0 || !outOfBand(pct, lo, hi, judging)) return null;
  const windows = cond.on === 'target' ? ctx.targetAuras : ctx.selfAuras;
  const merged = mergedUpSpans(windows, cond.aura_spell_id, ctx.fightDurationS);
  const gaps = uptimeGaps(merged, ctx.fightDurationS);
  return {
    severity, category: 'rule_violation',
    label: `${cond.aura_spell_name} uptime`,
    message: `${cond.aura_spell_name} was up ${PERCENT_POINTS.format(pct)} of the fight. Aim for ${PERCENT_POINTS.format(lo)} or more.`,
    measured: { value: `${Math.round(pct)} / ${Math.round(lo)}`, unit: '% uptime' },
    details: remedy ? { remedy } : undefined,
    occurrences: gaps.map(([start, end]): FindingOccurrence => ({
      atS: round(start, 3), ok: false, label: `${round(end - start, 0)}s`,
      detail: `${cond.aura_spell_name} was down here for ${round(end - start, 0)}s.`,
    })),
    timeline: { segmentsS: merged, fightDurationS: ctx.fightDurationS },
  };
}

function openerProgress(
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

interface OpenerStepResult { ok: boolean; atS?: number; name: string; }

/** Every step's own result, unlike `openerProgress` which stops walking at the first miss - a later step can still land. */
function openerSteps(cond: OpeningSequenceCondition, ctx: RuleContext, pullS: number, deadlineS: number): OpenerStepResult[] {
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

function openingSequenceOccurrences(
  cond: OpeningSequenceCondition, ctx: RuleContext, pullS: number, deadlineS: number,
): FindingOccurrence[] {
  return openerSteps(cond, ctx, pullS, deadlineS).map(step =>
    step.ok
      ? { atS: step.atS, ok: true, label: step.name, detail: `${step.name} landed on time in its slot.` }
      : { ok: false, label: step.name, note: 'not reached', detail: `${step.name} was never reached in the opener window.` });
}

export function evaluateOpeningSequence(
  cond: OpeningSequenceCondition, ctx: RuleContext, band: RuleBand, _judging: RuleJudging, severity: Severity, remedy?: string,
): AnalysisFinding | null {
  const hi = bandLimits(SECONDS, band).hi;
  const progress = openerProgress(cond, ctx, hi);
  if (!progress || progress.completedS != null) return null;
  return {
    severity, category: 'rule_violation',
    timestamp_s: round(progress.pullS, 3),
    label: `Opener: ${cond.spell_names.join(' > ')}`,
    message: `Your opener got ${progress.matched} of ${cond.spell_ids.length} steps out. Top raiders finish all ${cond.spell_ids.length} within ${SECONDS.format(hi)}.`,
    measured: { value: `${progress.matched} / ${cond.spell_ids.length}`, unit: 'step(s)' },
    details: remedy ? { remedy } : undefined,
    occurrences: openingSequenceOccurrences(cond, ctx, progress.pullS, progress.pullS + hi),
    occurrenceTarget: `expected order: ${cond.spell_names.join(' > ')}`,
  };
}

/** Every enemy the player was damaging, since both bounds ask how many were up to be hit, not how many this ability struck. */
function targetsAtCast(damage: readonly DamageRow[], castTimeS: number): number {
  const fromS = castTimeS;
  const toS = fromS + TARGET_COUNT_WINDOW_S;
  const targets = new Set<string>();
  for (const [atS, target] of damage) {
    if (atS > toS) break;
    if (atS >= fromS) targets.add(target);
  }
  return targets.size;
}

function targetCountsPerCast(cond: CastAtTargetCountCondition, ctx: RuleContext): { timeS: number; targets: number }[] {
  return [...(ctx.castTimes[cond.spell_id] ?? [])].sort((a, b) => a - b)
    .map(timeS => ({ timeS, targets: targetsAtCast(ctx.damageIndex(), timeS) }))
    .filter(({ targets }) => targets > 0);
}

/** Shared by every per-cast kind so they cannot drift apart in maths or in voice. */
interface BoundedCasts {
  values: { timeS: number; value: number }[];
  scale: Scale;
  subject: string;
  /** Short noun phrase for the table row; `phrase` is the verb phrase the sentence needs, and `advice` the fix both share. */
  label: (limit: string) => string;
  phrase: (limit: string) => string;
  advice: (limit: string) => string;
  /** Names the mistake on the edge away from `primary`, for the kinds where overshooting is its own waste. */
  farLabel?: (limit: string) => string;
  farPhrase?: (limit: string) => string;
  farAdvice?: string;
}

function evaluateBoundedPerCast(
  judged: BoundedCasts, band: RuleBand, judging: RuleJudging, severity: Severity, remedy?: string,
): AnalysisFinding | null {
  if (!judged.values.length) return null;
  const { lo, hi } = bandLimits(judged.scale, band);
  const nearLimit = judging.primary === 'below' ? lo : hi;
  const farLimit = judging.primary === 'below' ? hi : lo;
  const violations = judged.values.filter(({ value }) => outOfBand(value, lo, hi, judging));
  if (!exceedsTolerance(violations.length, judged.values.length, band)) return null;
  const past = (value: number) => judging.primary === 'below' ? value > hi : value < lo;
  // A pull with both a near-side and a far-side violation keeps the primary phrasing (and its remedy) live, since the authored action still answers those casts.
  const { farPhrase, farAdvice, farLabel } = judged;
  const farSide = judging.twoSided && farPhrase != null && farAdvice != null && farLabel != null
    && violations.every(({ value }) => past(value));
  const phrase = farSide
    ? farPhrase(judged.scale.format(farLimit))
    : judged.phrase(judged.scale.format(nearLimit));
  const advice = farSide ? farAdvice : judged.advice(judged.scale.format(nearLimit));
  const label = farSide ? farLabel(judged.scale.format(farLimit)) : judged.label(judged.scale.format(nearLimit));
  const firstViolation = violations[0];
  if (firstViolation == null) return null;
  return {
    severity, category: 'rule_violation',
    timestamp_s: round(firstViolation.timeS, 3),
    label: `${judged.subject} ${label}`,
    message: `${violations.length} of ${judged.values.length} ${judged.subject} casts ${phrase}. ${advice}`,
    measured: { value: `${violations.length} / ${judged.values.length}`, unit: 'cast(s)' },
    details: remedy ? { remedy } : undefined,
    occurrences: sampleOccurrences(judged.values.map(({ timeS, value }): FindingOccurrence => {
      const label = judged.scale.format(value);
      return {
        atS: round(timeS, 3), ok: !outOfBand(value, lo, hi, judging), label,
        detail: `${judged.subject} cast at ${label}.`,
      };
    })),
    occurrenceTarget: judged.advice(judged.scale.format(nearLimit)),
  };
}

export function evaluateCastAtTargetCount(
  cond: CastAtTargetCountCondition, ctx: RuleContext, band: RuleBand, judging: RuleJudging, severity: Severity, remedy?: string,
): AnalysisFinding | null {
  return evaluateBoundedPerCast({
    values: targetCountsPerCast(cond, ctx).map(({ timeS, targets }) => ({ timeS, value: targets })),
    scale: WHOLE_STEPS,
    subject: cond.spell_name,
    label: limit => `at ${cond.bound === 'min' ? 'under' : 'over'} ${limit} targets`,
    phrase: limit => cond.bound === 'min' ? `hit fewer than ${limit} targets` : `hit more than ${limit} targets`,
    advice: limit => cond.bound === 'min' ? `Wait for ${limit} or more.` : `Use it on ${limit} or fewer.`,
  }, band, judging, severity, remedy);
}

function resourceAt(rows: readonly ResourceRow[], castS: number): { amount: number; max: number } | null {
  let latest: ResourceRow | undefined;
  for (const row of rows) {
    if (row[0] > castS) break;
    latest = row;
  }
  if (!latest || latest[0] < castS - RESOURCE_SAMPLE_WINDOW_S) return null;
  return { amount: latest[1], max: latest[2] };
}

/** A share of the pool's own cap, so one bench band stays meaningful across pools whose scales differ by orders of magnitude - the runtime side converts back to the player's own amount/max for display. */
function resourceFractionPerCast(
  cond: ResourceAtCastCondition, ctx: RuleContext,
): { timeS: number; frac: number; amount: number; max: number }[] {
  const judged: { timeS: number; frac: number; amount: number; max: number }[] = [];
  for (const event of ctx.castEvents) {
    if (event.type !== 'cast' || event.abilityGameID !== cond.spell_id) continue;
    if (event.resourceActor != null && event.resourceActor !== RESOURCE_ACTOR_SOURCE) continue;
    const own = event.classResources?.find(resource => resource.type === cond.resource_type);
    const pool = own?.max
      ? { amount: own.amount, max: own.max }
      : resourceAt(ctx.resourcePool(cond.resource_type), event.atS);
    if (!pool) continue;
    judged.push({ timeS: event.atS, frac: pool.amount / pool.max, amount: pool.amount, max: pool.max });
  }
  return judged;
}

/** WCL reports mana as a five/six-digit pool - every other resource this kind judges tops out near 100 - so only mana renders as a percent; everything else reads as a raw count against its own cap. */
const RAW_COUNT_MAX_POOL = 200;

function rawCountScale(max: number): Scale {
  return {
    quantize: fraction => Math.round(fraction * max), format: value => `${Math.round(value)}/${max}`,
    span: (lo, hi) => lo === hi ? `${lo}/${max}` : `${lo}-${hi}/${max}`,
  };
}

export function evaluateResourceAtCast(
  cond: ResourceAtCastCondition, ctx: RuleContext, band: RuleBand, judging: RuleJudging, severity: Severity, remedy?: string,
): AnalysisFinding | null {
  const judged = resourceFractionPerCast(cond, ctx);
  const firstJudged = judged[0];
  if (!firstJudged) return null;
  const max = firstJudged.max;
  const raw = max <= RAW_COUNT_MAX_POOL;
  return evaluateBoundedPerCast({
    values: judged.map(({ timeS, frac, amount }) => ({ timeS, value: raw ? amount : frac })),
    scale: raw ? rawCountScale(max) : PERCENT,
    subject: cond.spell_name,
    label: limit => `${cond.bound === 'min' ? 'below' : 'above'} ${limit} ${cond.resource_name}`,
    phrase: limit => `were spent ${cond.bound === 'min' ? 'below' : 'above'} ${limit} ${cond.resource_name}`,
    advice: limit => cond.bound === 'min' ? `Spend at ${limit} or more.` : `Spend at ${limit} or less.`,
    farLabel: limit => `above ${limit} ${cond.resource_name}`,
    farPhrase: limit => `were spent above ${limit} ${cond.resource_name}`,
    farAdvice: 'Spend before you cap.',
  }, band, judging, severity, remedy);
}

/** A proc still up when the pull ends has not been wasted, whether the log closed its span at the kill or left it open. */
function closedProcSpans(cond: ProcWastedCondition, ctx: RuleContext): [number, number][] {
  return (ctx.selfAuras.get(cond.buff_spell_id) ?? [])
    .filter((span): span is [number, number] => span[1] != null && span[1] < ctx.fightDurationS);
}

function procSpent(cond: ProcWastedCondition, ctx: RuleContext): (span: [number, number]) => boolean {
  const spendTimes = cond.spend_spell_ids.flatMap(spellId => ctx.castTimes[spellId] ?? []);
  return ([startS, endS]) => spendTimes.some(time => time >= startS && time <= endS);
}

function wastedProcShare(cond: ProcWastedCondition, ctx: RuleContext): number | null {
  const spans = closedProcSpans(cond, ctx);
  const firstSpan = spans[0];
  if (firstSpan == null) return null;
  const spent = procSpent(cond, ctx);
  return spans.filter(span => !spent(span)).length / spans.length;
}

export function evaluateProcWasted(
  cond: ProcWastedCondition, ctx: RuleContext, band: RuleBand, judging: RuleJudging, severity: Severity, remedy?: string,
): AnalysisFinding | null {
  const { lo, hi } = bandLimits(PERCENT, band);
  const spans = closedProcSpans(cond, ctx);
  if (!spans.length) return null;
  const spent = procSpent(cond, ctx);
  const wasted = spans.filter(span => !spent(span));
  if (!outOfBand(wasted.length / spans.length, lo, hi, judging)) return null;
  // Above-only judging: an out-of-band waste rate implies at least one wasted proc.
  const firstWasted = wasted[0];
  if (firstWasted == null) return null;
  return {
    severity, category: 'rule_violation',
    timestamp_s: round(firstWasted[0], 3),
    label: `${cond.buff_spell_name} wasted`,
    message: `${cond.buff_spell_name} expired unused ${wasted.length} of ${spans.length} times. Top raiders ${hi <= 0 ? 'never waste it' : `waste at most ${oneIn(hi)}`}.`,
    measured: { value: `${wasted.length} / ${spans.length}`, unit: 'proc(s)' },
    details: remedy ? { remedy } : undefined,
    occurrences: sampleOccurrences(spans.map((span): FindingOccurrence => {
      const used = spent(span);
      return {
        atS: round(span[0], 3), ok: used, label: used ? 'used' : 'wasted',
        detail: used ? `${cond.buff_spell_name} was spent before it expired.` : `${cond.buff_spell_name} expired unspent here.`,
      };
    })),
    occurrenceTarget: `spent ${hi <= 0 ? 'every time' : `on all but ${oneIn(hi)}`}`,
  };
}

/** Shared by both filler kinds so the two can only differ in their gate. */
interface FillerSplit {
  coached: number;
  total: number;
  /** Where the replay opens, so the finding points at the first cast that should have been the coached one. */
  firstAlternativeS: number | null;
}

function splitFillers(
  coachedId: number, alternativeIds: number[], castTimesS: (spellId: number) => number[],
): FillerSplit {
  const coached = castTimesS(coachedId).length;
  const alternatives = alternativeIds.flatMap(castTimesS);
  return {
    coached,
    total: coached + alternatives.length,
    firstAlternativeS: alternatives.length ? Math.min(...alternatives) : null,
  };
}

/** Share of the filler choice the coached spell won, or null when the pull never filled under that gate. */
function fillerShare(split: FillerSplit): number | null {
  return split.total ? split.coached / split.total : null;
}

function fillerFinding(
  split: FillerSplit, band: RuleBand, judging: RuleJudging, severity: Severity,
  spellName: string, where: string, remedy?: string,
): AnalysisFinding | null {
  const { lo, hi } = bandLimits(PERCENT, band);
  const share = fillerShare(split);
  if (share == null || !outOfBand(share, lo, hi, judging)) return null;
  return {
    severity, category: 'rule_violation',
    timestamp_s: split.firstAlternativeS == null ? undefined : round(split.firstAlternativeS, 3),
    label: `${spellName} ${where}`,
    message: `${spellName} was only ${PERCENT.format(share)} of your fillers ${where}. Aim for ${PERCENT.format(lo)} or more.`,
    measured: { value: `${Math.round(share * 100)} / ${Math.round(lo * 100)}`, unit: '% of fillers' },
    details: remedy ? { remedy } : undefined,
    occurrences: [],
  };
}

/** Shared by both filler kinds so their chip logic cannot drift apart. */
function fillerOccurrences(
  coachedId: number, coachedName: string, alternativeIds: number[], alternativeNames: string[],
  timesFor: (spellId: number) => number[],
): FindingOccurrence[] {
  const entries: { atS: number; ok: boolean; label: string }[] = [
    ...timesFor(coachedId).map(time => ({ atS: round(time, 3), ok: true, label: coachedName })),
    ...alternativeIds.flatMap((spellId, i) => {
      const name = alternativeNames[i] ?? String(spellId);
      return timesFor(spellId).map(time => ({ atS: round(time, 3), ok: false, label: name }));
    }),
  ];
  entries.sort((a, b) => a.atS - b.atS);
  return sampleOccurrences(entries.map(entry => ({
    ...entry,
    detail: entry.ok
      ? `${entry.label} was the coached filler here.`
      : `${entry.label} was pressed instead of ${coachedName} here.`,
  })));
}

function fillerInBuffTimesFor(cond: FillerInBuffCondition, ctx: RuleContext): (spellId: number) => number[] {
  return spellId => (ctx.castTimes[spellId] ?? []).filter(time =>
    auraAlreadyUpAt(ctx.selfAuras, cond.buff_spell_id, time)
    && !suspendedAt(cond.except_buff_spell_ids, ctx, time));
}

function fillerCastsInBuff(cond: FillerInBuffCondition, ctx: RuleContext): FillerSplit {
  return splitFillers(cond.spell_id, cond.alternative_spell_ids, fillerInBuffTimesFor(cond, ctx));
}

export function evaluateFillerInBuff(
  cond: FillerInBuffCondition, ctx: RuleContext, band: RuleBand, judging: RuleJudging, severity: Severity, remedy?: string,
): AnalysisFinding | null {
  const finding = fillerFinding(fillerCastsInBuff(cond, ctx), band, judging, severity,
    cond.spell_name, `during ${cond.buff_spell_name}`, remedy);
  if (!finding) return null;
  return {
    ...finding,
    occurrences: fillerOccurrences(
      cond.spell_id, cond.spell_name, cond.alternative_spell_ids, cond.alternative_spell_names,
      fillerInBuffTimesFor(cond, ctx),
    ),
    occurrenceTarget: `${PERCENT.format(bandLimits(PERCENT, band).lo)} or more ${cond.spell_name} during ${cond.buff_spell_name}`,
  };
}

/** A state the rule agreed not to judge under, so a window the sources say to press the other button in is not counted against the player. */
function suspendedAt(exceptIds: number[] | undefined, ctx: RuleContext, timeS: number): boolean {
  return (exceptIds ?? []).some(spellId => auraUpAt(ctx.selfAuras, spellId, timeS));
}

/** Drops a cast whose count falls before the buff's first recorded trace, rather than scoring an unknowable count as zero. */
function stackCountsPerCast(cond: SpendAtStacksCondition, ctx: RuleContext): { timeS: number; stacks: number }[] {
  const timeline = ctx.stacks(cond.buff_spell_id);
  return [...(ctx.castTimes[cond.spell_id] ?? [])].sort((a, b) => a - b)
    .filter(timeS => !suspendedAt(cond.except_buff_spell_ids, ctx, timeS))
    .map(timeS => ({ timeS, stacks: stacksAt(timeline, timeS) }))
    .filter((entry): entry is { timeS: number; stacks: number } => entry.stacks !== null);
}

export function evaluateSpendAtStacks(
  cond: SpendAtStacksCondition, ctx: RuleContext, band: RuleBand, judging: RuleJudging, severity: Severity, remedy?: string,
): AnalysisFinding | null {
  // No declared cap means no domain and no band, so the rule was already dropped; bail rather than judge on a guess.
  const maxStacks = cond.max_stacks;
  if (maxStacks == null) return null;
  // Over the bar is overcapping, which is what a player sees; under it is spending cheap.
  const wording = cond.bound === 'min' ? 'under' : 'over';
  // Keep WHOLE_STEPS's own rounding: rawCountScale's quantize multiplies by max, which is only valid for a fractional threshold, not this measure's raw stack count.
  const capScale = rawCountScale(maxStacks);
  const scale: Scale = { quantize: WHOLE_STEPS.quantize, format: capScale.format, span: capScale.span };
  return evaluateBoundedPerCast({
    values: stackCountsPerCast(cond, ctx).map(({ timeS, stacks }) => ({ timeS, value: stacks })),
    scale,
    subject: cond.spell_name,
    label: limit => `at ${wording} ${limit} ${cond.buff_spell_name}`,
    phrase: limit => `were spent ${wording} ${limit} stacks of ${cond.buff_spell_name}${cond.bound === 'max' ? ', overcapping' : ''}`,
    advice: limit => cond.bound === 'min' ? `Spend at ${limit} or more.` : `Spend at ${limit} or less.`,
    farLabel: limit => `past ${limit} ${cond.buff_spell_name}`,
    farPhrase: limit => `were held past ${limit} stacks of ${cond.buff_spell_name}`,
    farAdvice: 'Spend before you cap.',
  }, band, judging, severity, remedy);
}

type ClosedSpan = AuraSpan & { endS: number };

/** Narrows in one place, so the spans that ran to an end are handled without asserting on every read. */
function closedSpans(perTarget: AuraSpansByTarget): ClosedSpan[] {
  return [...perTarget.values()].flat().filter((span): span is ClosedSpan => span.endS != null);
}

function clipSpans(cond: AuraClippedCondition, ctx: RuleContext): AuraSpansByTarget {
  return cond.on === 'target' ? ctx.targetSpans(cond.aura_spell_id) : ctx.selfSpans(cond.aura_spell_id);
}

/** Only a re-application the player cast counts, since most refreshes in a log are procs rather than presses. */
function hardCastRefreshes(cond: AuraClippedCondition, ctx: RuleContext): ClosedSpan[] {
  const castTimes = ctx.castTimes[cond.cast_spell_id] ?? [];
  // One-sided: a cast after the refresh cannot have caused it.
  const cast = (atS: number) => castTimes.some(time => atS - time >= 0 && atS - time <= HARD_CAST_WINDOW_S);
  return closedSpans(clipSpans(cond, ctx))
    .filter(span => span.endedByRefresh && cast(span.endS)
      && !suspendedAt(cond.except_buff_spell_ids, ctx, span.endS));
}

/** Needs no authored duration, so neither a death-truncated span nor a pandemic-extended one can skew it. */
function elapsedAtRefresh(cond: AuraClippedCondition, ctx: RuleContext): { timeS: number; elapsedS: number }[] {
  return hardCastRefreshes(cond, ctx)
    .map(span => ({ timeS: span.endS, elapsedS: span.endS - span.startS }))
    .sort((a, b) => a.timeS - b.timeS);
}

export function evaluateAuraClipped(
  cond: AuraClippedCondition, ctx: RuleContext, band: RuleBand, judging: RuleJudging, severity: Severity, remedy?: string,
): AnalysisFinding | null {
  const { lo, hi } = bandLimits(SECONDS, band);
  const judged = elapsedAtRefresh(cond, ctx);
  if (!judged.length) return null;
  const clipped = judged.filter(({ elapsedS }) => outOfBand(elapsedS, lo, hi, judging));
  if (!exceedsTolerance(clipped.length, judged.length, band)) return null;
  const firstClipped = clipped[0];
  if (firstClipped == null) return null;
  const outValues = clipped.map(entry => entry.elapsedS);
  return {
    severity, category: 'rule_violation',
    timestamp_s: round(firstClipped.timeS, 3),
    label: `${cond.aura_spell_name} clipped`,
    message: `You refreshed ${cond.aura_spell_name} early ${clipped.length} of ${judged.length} times, on average ${SECONDS.format(median(outValues) ?? 0)} in. Let it run at least ${SECONDS.format(lo)}.`,
    measured: { value: `${clipped.length} / ${judged.length}`, unit: 'refresh(es)' },
    details: remedy ? { remedy } : undefined,
    occurrences: sampleOccurrences(judged.map(({ timeS, elapsedS }): FindingOccurrence => ({
      atS: round(timeS, 3), ok: !outOfBand(elapsedS, lo, hi, judging), label: SECONDS.format(elapsedS),
      detail: `Refreshed ${SECONDS.format(elapsedS)} into the aura.`,
    }))),
    occurrenceTarget: `let it run at least ${SECONDS.format(lo)}`,
  };
}

/** Health rides on damage rows rather than casts, so a cast reads the latest snapshot of THE ENEMY IT NAMED - a tick on a dying add otherwise licenses an execute against a full-health boss. */
function targetHealthFracAt(ctx: RuleContext, cast: TimedEvent): number | null {
  const castS = cast.atS;
  const rows = ctx.targetHealth(targetKey(cast));
  let latest: HealthRow | undefined;
  for (const row of rows) {
    if (row[0] > castS) break;
    latest = row;
  }
  if (!latest || latest[0] < castS - HEALTH_SAMPLE_WINDOW_S) return null;
  return latest[1];
}

function fillerBelowHealthTimesFor(cond: FillerBelowHealthCondition, ctx: RuleContext): (spellId: number) => number[] {
  const gate = cond.health_pct / 100;
  return spellId => ctx.castEvents
    .filter(event => {
      if (event.type !== 'cast' || event.abilityGameID !== spellId) return false;
      if (suspendedAt(cond.except_buff_spell_ids, ctx, event.atS)) return false;
      const frac = targetHealthFracAt(ctx, event);
      return frac != null && frac <= gate;
    })
    .map(event => event.atS);
}

function fillersBelowHealth(cond: FillerBelowHealthCondition, ctx: RuleContext): FillerSplit {
  return splitFillers(cond.spell_id, cond.alternative_spell_ids, fillerBelowHealthTimesFor(cond, ctx));
}

export function evaluateFillerBelowHealth(
  cond: FillerBelowHealthCondition, ctx: RuleContext, band: RuleBand, judging: RuleJudging, severity: Severity, remedy?: string,
): AnalysisFinding | null {
  const finding = fillerFinding(fillersBelowHealth(cond, ctx), band, judging, severity,
    cond.spell_name, `under ${cond.health_pct}% health`, remedy);
  if (!finding) return null;
  return {
    ...finding,
    occurrences: fillerOccurrences(
      cond.spell_id, cond.spell_name, cond.alternative_spell_ids, cond.alternative_spell_names,
      fillerBelowHealthTimesFor(cond, ctx),
    ),
    occurrenceTarget: `${PERCENT.format(bandLimits(PERCENT, band).lo)} or more ${cond.spell_name} under ${cond.health_pct}% health`,
  };
}

/** Short chip label for a rulebook rule `type`, matching the tone of `CAT_LABEL`. */
export const RULE_TYPE_LABEL: Record<string, string> = {
  cooldown_pairing: 'pairing',
  cd_hold: 'cd hold',
  opener: 'opener',
  rotation: 'rotation',
  aoe_switch: 'aoe',
};

/** The optional event streams a rule reads beyond the always-fetched casts and buffs. `targetHealth` rides on `damage`, asking for its heavier resource-bearing form. */
export type RuleStream = 'enemyAuras' | 'damage' | 'targetHealth';

/** The measured quantity's own bounds and step, so an edge with no room past it is recognised as unviolatable. `max: null` is a genuinely unbounded metric. */
interface RuleDomain {
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
interface KindSpec<C extends RuleCondition> {
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
    cond: C, ctx: RuleContext, band: RuleBand | null, judging: RuleJudging, severity: Severity, remedy?: string,
  ) => AnalysisFinding | null;
  applicable: (cond: C, ctx: RuleContext) => boolean;
  label: (cond: C) => string;
}

function withBand<C extends RuleCondition>(
  evaluate: (
    cond: C, ctx: RuleContext, band: RuleBand, judging: RuleJudging, severity: Severity, remedy?: string,
  ) => AnalysisFinding | null,
): KindSpec<C>['evaluate'] {
  return (cond, ctx, band, judging, severity, remedy) => band && evaluate(cond, ctx, band, judging, severity, remedy);
}

/** Keyed by kind, so a new condition cannot compile until it declares every field. */
const RULE_KINDS: { [K in RuleCondition['kind']]: KindSpec<Extract<RuleCondition, { kind: K }>> } = {
  cast_without_prior: {
    streams: () => [],
    pooling: 'instance',
    judging: () => ({ primary: 'above', twoSided: false }),
    domain: () => ({ min: 0, max: null }),
    sample: (cond, ctx) => leadPerCast(cond, ctx.castTimes).filter((lead): lead is number => lead != null),
    // An unpaired cast is the violation this kind is named for, but it has no lead to pool, so it reaches tolerance this way instead.
    unmeasured: (cond, ctx) => leadPerCast(cond, ctx.castTimes).filter(lead => lead == null).length,
    evaluate: withBand(evaluateCastWithoutPrior),
    applicable: (cond, ctx) => castCount(ctx, cond.spell_id) > 0,
    label: cond => `${cond.spell_name} with ${cond.required_spell_name}`,
  },
  hold_cooldown_for_anchor: {
    streams: () => [],
    pooling: 'instance',
    // A large gap is a charge spent right after the previous anchor, which is the prompt play, not a hold.
    judging: () => ({ primary: 'below', twoSided: false }),
    domain: () => ({ min: 0, max: null }),
    sample: (cond, ctx) => gapToNextAnchor(cond, ctx).map(entry => entry.gapS),
    evaluate: withBand(evaluateHoldForAnchor),
    applicable: (cond, ctx) => holdAnchors(cond, ctx.castTimes).length > 0
      && cond.spell_ids.some(spellId => castCount(ctx, spellId) > 0),
    label: cond => `${cond.spell_names.join('/')} held for ${cond.anchor_spell_name}`,
  },
  cast_outside_buff: {
    streams: () => [],
    pooling: 'parse',
    judging: () => ({ primary: 'above', twoSided: false }),
    domain: () => ({ min: 0, max: 1 }),
    sample: (cond, ctx) => {
      const share = offSideShare(cond, ctx);
      return share == null ? [] : [share];
    },
    evaluate: withBand(evaluateCastOutsideBuff),
    applicable: (cond, ctx) => castCount(ctx, cond.spell_id) > 0,
    label: cond => `${cond.spell_name} ${cond.require} ${cond.buff_spell_name}`,
  },
  aura_uptime_below: {
    streams: cond => cond.on === 'target' ? ['enemyAuras'] : [],
    pooling: 'parse',
    judging: () => ({ primary: 'below', twoSided: false }),
    domain: () => ({ min: 0, max: 100 }),
    sample: (cond, ctx) => {
      const pct = uptimePct(cond, ctx);
      return pct > 0 ? [pct] : [];
    },
    evaluate: withBand(evaluateAuraUptimeBelow),
    applicable: (cond, ctx) => uptimePct(cond, ctx) > 0,
    label: cond => `${cond.aura_spell_name} uptime`,
  },
  opening_sequence: {
    streams: () => [],
    pooling: 'parse',
    judging: () => ({ primary: 'above', twoSided: false }),
    domain: () => ({ min: 0, max: null }),
    // Measured against the whole pull, since the window being derived cannot gate its own measurement.
    sample: (cond, ctx) => {
      const completedS = openerProgress(cond, ctx, ctx.fightDurationS)?.completedS;
      return completedS == null ? [] : [completedS];
    },
    evaluate: withBand(evaluateOpeningSequence),
    applicable: (cond, ctx) => cond.spell_ids.some(spellId => castCount(ctx, spellId) > 0),
    label: cond => `Opener: ${cond.spell_names.join(' > ')}`,
  },
  cast_at_target_count: {
    streams: () => ['damage'],
    pooling: 'instance',
    judging: cond => ({ primary: cond.bound === 'min' ? 'below' : 'above', twoSided: false }),
    domain: () => ({ min: 1, max: null, step: 1 }),
    sample: (cond, ctx) => targetCountsPerCast(cond, ctx).map(entry => entry.targets),
    evaluate: withBand(evaluateCastAtTargetCount),
    applicable: (cond, ctx) => targetCountsPerCast(cond, ctx).length > 0,
    label: cond => `${cond.spell_name} target count`,
  },
  resource_at_cast: {
    streams: () => [],
    pooling: 'instance',
    // Spending above a floor has a live far side: sitting at the cap is wasted generation. A ceiling rule has none - spending at empty costs nothing.
    judging: cond => ({ primary: cond.bound === 'min' ? 'below' : 'above', twoSided: cond.bound === 'min' }),
    // Declares no step on purpose: the real one is 1/max of the player's own pool, which bake cannot know, so tolerance carries up to one display step of slack rather than snapping to a cap the field cannot supply.
    domain: () => ({ min: 0, max: 1 }),
    sample: (cond, ctx) => resourceFractionPerCast(cond, ctx).map(entry => entry.frac),
    evaluate: withBand(evaluateResourceAtCast),
    applicable: (cond, ctx) => resourceFractionPerCast(cond, ctx).length > 0,
    label: cond => `${cond.spell_name} at ${cond.resource_name}`,
  },
  proc_wasted: {
    streams: () => [],
    pooling: 'parse',
    judging: () => ({ primary: 'above', twoSided: false }),
    domain: () => ({ min: 0, max: 1 }),
    sample: (cond, ctx) => {
      const share = wastedProcShare(cond, ctx);
      return share == null ? [] : [share];
    },
    evaluate: withBand(evaluateProcWasted),
    applicable: (cond, ctx) => closedProcSpans(cond, ctx).length > 0,
    label: cond => `${cond.buff_spell_name} spent`,
  },
  filler_in_buff: {
    streams: () => [],
    pooling: 'parse',
    judging: () => ({ primary: 'below', twoSided: false }),
    domain: () => ({ min: 0, max: 1 }),
    sample: (cond, ctx) => {
      const share = fillerShare(fillerCastsInBuff(cond, ctx));
      return share == null ? [] : [share];
    },
    evaluate: withBand(evaluateFillerInBuff),
    applicable: (cond, ctx) => fillerCastsInBuff(cond, ctx).total > 0,
    label: cond => `${cond.spell_name} in ${cond.buff_spell_name}`,
  },
  spend_at_stacks: {
    streams: () => [],
    pooling: 'instance',
    // Spending above a floor has a live far side: sitting at the cap wastes generation. A ceiling rule has none - spending at zero stacks costs nothing.
    judging: cond => ({ primary: cond.bound === 'min' ? 'below' : 'above', twoSided: cond.bound === 'min' }),
    domain: cond => cond.max_stacks == null ? null : { min: 0, max: cond.max_stacks, step: 1 },
    sample: (cond, ctx) => stackCountsPerCast(cond, ctx).map(entry => entry.stacks),
    evaluate: withBand(evaluateSpendAtStacks),
    applicable: (cond, ctx) => stackCountsPerCast(cond, ctx).length > 0,
    label: cond => `${cond.spell_name} at ${cond.buff_spell_name}`,
  },
  aura_clipped: {
    streams: cond => cond.on === 'target' ? ['enemyAuras'] : [],
    pooling: 'instance',
    judging: () => ({ primary: 'below', twoSided: false }),
    domain: () => ({ min: 0, max: null }),
    sample: (cond, ctx) => elapsedAtRefresh(cond, ctx).map(entry => entry.elapsedS),
    evaluate: withBand(evaluateAuraClipped),
    applicable: (cond, ctx) => elapsedAtRefresh(cond, ctx).length > 0,
    label: cond => `${cond.aura_spell_name} clipped`,
  },
  filler_below_health: {
    streams: () => ['damage', 'targetHealth'],
    pooling: 'parse',
    judging: () => ({ primary: 'below', twoSided: false }),
    domain: () => ({ min: 0, max: 1 }),
    sample: (cond, ctx) => {
      const share = fillerShare(fillersBelowHealth(cond, ctx));
      return share == null ? [] : [share];
    },
    evaluate: withBand(evaluateFillerBelowHealth),
    applicable: (cond, ctx) => fillersBelowHealth(cond, ctx).total > 0,
    label: cond => `${cond.spell_name} under ${cond.health_pct}% health`,
  },
};

/** The engine's one cast: the table is keyed by `kind`, so an entry always matches the condition that looked it up. */
function specFor<C extends RuleCondition>(cond: C): KindSpec<C> {
  return RULE_KINDS[cond.kind] as unknown as KindSpec<C>;
}

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
  cond: RuleCondition, ctx: RuleContext, band: RuleBand | null, severity: Severity, remedy?: string,
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
    if (finding) findings.push({ ...finding, rule_type: rule.type, label: rule.description ?? finding.label });
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
