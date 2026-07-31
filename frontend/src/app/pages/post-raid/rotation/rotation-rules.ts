// Separate from rotation.service.ts so the ingest transform measures top parses with the same code the runtime judges the player with.
import { median, deviation } from 'd3-array';
import { getOrInsert, round } from '../../../shared/analysis/analysis-math';
import { AnalysisFinding } from '../../../core/models/analysis.models';
import {
  RulebookRule, RuleCondition,
  CastWithoutPriorCondition, HoldCooldownForAnchorCondition, CastOutsideBuffCondition,
  AuraUptimeBelowCondition, OpeningSequenceCondition,
  CastAtTargetCountCondition, ResourceAtCastCondition, ProcWastedCondition, FillerInBuffCondition,
  SpendAtStacksCondition, AuraClippedCondition, FillerBelowHealthCondition,
} from '../../../core/models/rulebook.models';
import { WclEvent } from '../../../core/models/wcl.models';
import { targetKey } from '../../../shared/analysis/wcl-projections';
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

/** A re-application this soon AFTER a cast is that cast landing: measured deltas run 0-28ms, so this covers projectile flight without reaching the next proc. */
const HARD_CAST_WINDOW_S = 0.25;

/** A magnitude the encounter supplies in place of a number nobody should author. */
export interface RuleThreshold {
  /** Median across the parses it could be measured on. */
  value: number;
  /** Tolerance half-width, so parse-to-parse jitter is not coached. */
  band: number;
}

/** Floor on the band as a share of the median, so a tightly clustered field still tolerates jitter. */
const THRESHOLD_BAND_MIN_FRAC = 0.1;

/** A threshold needs this share of the sampled parses to be measurable, matching the other consensus gates. */
const THRESHOLD_SAMPLE_FRAC = 0.5;

export interface BenchedRule {
  rule: RulebookRule;
  /** Null when the kind needs no magnitude, or when too few parses could supply one. */
  threshold: RuleThreshold | null;
  /** Parses the magnitude could be measured on. */
  sample_count: number;
}

export type CastTimes = Record<number, number[]>;

export function buildCastTimes(casts: WclEvent[], fStart: number): CastTimes {
  const castTimes: CastTimes = {};
  for (const cast of casts) {
    if (cast.type === 'cast' && cast.abilityGameID) {
      (castTimes[cast.abilityGameID] ??= []).push((cast.timestamp - fStart) / 1000);
    }
  }
  return castTimes;
}

/** Damage rows as `[atMs, targetKey]`, time-ordered so a window is a slice rather than a scan. */
type DamageRow = [number, string];

/** One enemy's health as `[atMs, share of max]`, time-ordered. */
type HealthRow = [number, number];

/** Everything the rule evaluators read, derived once per pull. */
export interface RuleContext {
  castTimes: CastTimes;
  castEvents: WclEvent[];
  fStart: number;
  fightDurationS: number;
  /** Fight start to the player's first death, so a corpse is never coached for what it could not maintain. */
  aliveDurationS: number;
  selfAuras: AuraWindows;
  targetAuras: AuraWindows;
  /** Called rather than read: each builds on first use, and only for the one aura the rule names. */
  stacks: (spellId: number) => StackTimeline;
  selfSpans: (spellId: number) => AuraSpansByTarget;
  targetSpans: (spellId: number) => AuraSpansByTarget;
  damageIndex: () => readonly DamageRow[];
  targetHealth: (key: string) => readonly HealthRow[];
}

/** Built on first call and kept, so a stream no rulebook asks about costs nothing. */
function lazy<T extends object>(build: () => T): () => T {
  let value: T | undefined;
  return () => (value ??= build());
}

function perSpell<T extends object>(build: (spellId: number) => T): (spellId: number) => T {
  const cache = new Map<number, T>();
  return spellId => getOrInsert(cache, spellId, () => build(spellId));
}

function buildDamageIndex(damage: WclEvent[]): DamageRow[] {
  return damage.map((event): DamageRow => [event.timestamp, targetKey(event)]).sort((a, b) => a[0] - b[0]);
}

/** Only the resource-bearing rows carry health, and only for whoever was hit. */
function buildHealthIndex(damage: WclEvent[]): Map<string, HealthRow[]> {
  const index = new Map<string, HealthRow[]>();
  for (const event of damage) {
    if (event.resourceActor !== RESOURCE_ACTOR_TARGET || event.hitPoints == null || !event.maxHitPoints) continue;
    getOrInsert(index, targetKey(event), (): HealthRow[] => []).push([event.timestamp, event.hitPoints / event.maxHitPoints]);
  }
  for (const rows of index.values()) rows.sort((a, b) => a[0] - b[0]);
  return index;
}

/** First index where the monotone `past` turns true, so a time-ordered index is bisected rather than scanned per cast. */
function partitionPoint(length: number, past: (index: number) => boolean): number {
  let lo = 0, hi = length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (past(mid)) hi = mid; else lo = mid + 1;
  }
  return lo;
}

export interface RuleInputs {
  casts: WclEvent[];
  buffs: WclEvent[];
  debuffs: WclEvent[];
  damage: WclEvent[];
  /** The player's own, not the raid's. */
  deaths: WclEvent[];
  fStart: number;
  fEnd: number;
}

export function buildRuleContext(input: RuleInputs): RuleContext {
  const fightDurationS = (input.fEnd - input.fStart) / 1000;
  const deathTimes = input.deaths.map(event => (event.timestamp - input.fStart) / 1000);
  const health = lazy(() => buildHealthIndex(input.damage));
  return {
    castTimes: buildCastTimes(input.casts, input.fStart),
    castEvents: input.casts,
    fStart: input.fStart,
    fightDurationS,
    aliveDurationS: deathTimes.length ? Math.min(...deathTimes) : fightDurationS,
    selfAuras: buildAuraWindows(input.buffs, input.fStart),
    targetAuras: buildAuraWindows(input.debuffs, input.fStart),
    stacks: perSpell(spellId => buildStackTimeline(input.buffs, input.fStart, spellId)),
    selfSpans: perSpell(spellId => buildAuraSpansByTarget(input.buffs, input.fStart, spellId)),
    targetSpans: perSpell(spellId => buildAuraSpansByTarget(input.debuffs, input.fStart, spellId)),
    damageIndex: lazy(() => buildDamageIndex(input.damage)),
    targetHealth: key => health().get(key) ?? [],
  };
}

/** The threshold shifted to the forgiving side, so the field's own spread is never itself a finding. */
function lenient(threshold: RuleThreshold, direction: 'up' | 'down'): number {
  return direction === 'up' ? threshold.value + threshold.band : Math.max(0, threshold.value - threshold.band);
}

function castCount(ctx: RuleContext, spellId: number): number {
  return ctx.castTimes[spellId]?.length ?? 0;
}

/** `lead` is the judged cast minus the required one: positive when the required cast came first. */
function withinWindow(lead: number, win: number, position: 'before' | 'after' | 'either'): boolean {
  if (position === 'either') return Math.abs(lead) <= win;
  return position === 'before' ? lead >= 0 && lead <= win : lead <= 0 && -lead <= win;
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

export function evaluateCastWithoutPrior(
  cond: CastWithoutPriorCondition, ctx: RuleContext, threshold: RuleThreshold, severity: Severity, remedy?: string,
): AnalysisFinding | null {
  const win = lenient(threshold, 'up');
  const position = cond.position ?? 'before';
  const castTimes = ctx.castTimes;
  const primary = [...(castTimes[cond.spell_id] ?? [])].sort((a, b) => a - b);
  const required = castTimes[cond.required_spell_id] ?? [];
  const violations = primary.filter(time => !required.some(rt => withinWindow(time - rt, win, position)));
  if (!violations.length) return null;
  return {
    severity, category: 'rule_violation',
    timestamp_ms: Math.round(violations[0] * 1000),
    label: `${cond.spell_name} without ${cond.required_spell_name}`,
    message: `${cond.spell_name} without ${cond.required_spell_name} inside ${Math.round(win)}s: ${violations.length} of ${primary.length} cast(s).`,
    measured: { value: `${violations.length} / ${primary.length}`, unit: 'cast(s)' },
    details: remedy ? { remedy } : undefined,
  };
}

/** Non-opener anchor casts: the first is nothing to have held for. */
function holdAnchors(cond: HoldCooldownForAnchorCondition, castTimes: CastTimes): number[] {
  return [...(castTimes[cond.anchor_spell_id] ?? [])].sort((a, b) => a - b).slice(1);
}

export function evaluateHoldForAnchor(
  cond: HoldCooldownForAnchorCondition, ctx: RuleContext, threshold: RuleThreshold, severity: Severity, remedy?: string,
): AnalysisFinding | null {
  const holdWindowS = lenient(threshold, 'down');
  const anchorTimes = holdAnchors(cond, ctx.castTimes);
  const violations = cond.spell_ids.flatMap((spellId, i) => {
    const spellName = cond.spell_names?.[i] ?? String(spellId);
    return anchorTimes.flatMap(anchorTime =>
      (ctx.castTimes[spellId] ?? [])
        .filter(castTime => castTime >= anchorTime - holdWindowS && castTime < anchorTime)
        .map(castTime => ({ spellName, castTime })),
    );
  });
  if (!violations.length) return null;
  const firstCastS = violations.reduce((min, violation) => Math.min(min, violation.castTime), Infinity);
  const spellNames = [...new Set(violations.map(violation => violation.spellName))].join('/');
  return {
    severity, category: 'rule_violation',
    timestamp_ms: Math.round(firstCastS * 1000),
    label: `${spellNames} held before ${cond.anchor_spell_name}`,
    message: `${spellNames} used in the ${Math.round(holdWindowS)}s the field keeps clear before ${cond.anchor_spell_name}: ${violations.length} charge(s).`,
    measured: { value: `${violations.length}`, unit: 'charge(s)' },
    details: remedy ? { remedy } : undefined,
  };
}

export function evaluateCastOutsideBuff(
  cond: CastOutsideBuffCondition, ctx: RuleContext, severity: Severity, remedy?: string,
): AnalysisFinding | null {
  const primary = [...(ctx.castTimes[cond.spell_id] ?? [])].sort((a, b) => a - b);
  const violations = primary.filter(time =>
    auraUpAt(ctx.selfAuras, cond.buff_spell_id, time * 1000) !== (cond.require === 'inside'));
  if (!violations.length) return null;
  const relation = cond.require === 'inside' ? 'without' : 'during';
  return {
    severity, category: 'rule_violation',
    timestamp_ms: Math.round(violations[0] * 1000),
    label: `${cond.spell_name} ${relation} ${cond.buff_spell_name}`,
    message: `${cond.spell_name} ${relation} ${cond.buff_spell_name}: ${violations.length} of ${primary.length} cast(s).`,
    measured: { value: `${violations.length} / ${primary.length}`, unit: 'cast(s)' },
    details: remedy ? { remedy } : undefined,
  };
}

function uptimePct(cond: AuraUptimeBelowCondition, ctx: RuleContext): number {
  const windows = cond.on === 'target' ? ctx.targetAuras : ctx.selfAuras;
  // Alive time, since the top parses this is measured against do not die and so give no relief for the dead stretch.
  return auraUptimePct(windows, cond.aura_spell_id, ctx.aliveDurationS * 1000);
}

export function evaluateAuraUptimeBelow(
  cond: AuraUptimeBelowCondition, ctx: RuleContext, threshold: RuleThreshold, severity: Severity, remedy?: string,
): AnalysisFinding | null {
  const minPct = lenient(threshold, 'down');
  const pct = uptimePct(cond, ctx);
  // Zero uptime reads as a build that skips the aura rather than a mistake, which the app does not guess at.
  if (pct <= 0 || pct >= minPct) return null;
  return {
    severity, category: 'rule_violation',
    label: `${cond.aura_spell_name} uptime`,
    message: `${cond.aura_spell_name} up ${Math.round(pct)}% of the fight; the top parses hold ${Math.round(threshold.value)}%.`,
    measured: { value: `${Math.round(pct)} / ${Math.round(threshold.value)}`, unit: '% uptime' },
    details: remedy ? { remedy } : undefined,
  };
}

/** Steps completed in order within `windowS` of the pull, and the pull time itself. */
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

export function evaluateOpeningSequence(
  cond: OpeningSequenceCondition, ctx: RuleContext, threshold: RuleThreshold, severity: Severity, remedy?: string,
): AnalysisFinding | null {
  const windowS = lenient(threshold, 'up');
  const progress = openerProgress(cond, ctx, windowS);
  if (!progress || progress.completedS != null) return null;
  return {
    severity, category: 'rule_violation',
    timestamp_ms: Math.round(progress.pullS * 1000),
    label: `Opener: ${cond.spell_names.join(' > ')}`,
    message: `Opener reached ${progress.matched} of ${cond.spell_ids.length} steps in the ${Math.round(windowS)}s the top parses take.`,
    measured: { value: `${progress.matched} / ${cond.spell_ids.length}`, unit: 'step(s)' },
    details: remedy ? { remedy } : undefined,
  };
}

/** Every enemy the player was damaging, since both bounds ask how many were up to be hit, not how many this ability struck. */
function targetsAtCast(damage: readonly DamageRow[], fStart: number, castTimeS: number): number {
  const fromMs = fStart + castTimeS * 1000;
  const toMs = fromMs + TARGET_COUNT_WINDOW_S * 1000;
  const targets = new Set<string>();
  for (let i = partitionPoint(damage.length, index => damage[index][0] >= fromMs); i < damage.length && damage[i][0] <= toMs; i++) {
    targets.add(damage[i][1]);
  }
  return targets.size;
}

function targetCountsPerCast(cond: CastAtTargetCountCondition, ctx: RuleContext): { timeS: number; targets: number }[] {
  return [...(ctx.castTimes[cond.spell_id] ?? [])].sort((a, b) => a - b)
    .map(timeS => ({ timeS, targets: targetsAtCast(ctx.damageIndex(), ctx.fStart, timeS) }))
    .filter(({ targets }) => targets > 0);
}

/** A quantity's own steps: the limit snaps to them before it is compared, so the number in the copy is the number that judged the cast. */
interface Scale {
  quantize: (value: number) => number;
  format: (value: number) => string;
}

/** Targets and stacks come in whole units, and a fractional bar donates a full unit of slack that fires the rule a unit late. */
const WHOLE_STEPS: Scale = { quantize: Math.round, format: value => String(Math.round(value)) };

const PERCENT: Scale = { quantize: value => Math.round(value * 100) / 100, format: value => `${Math.round(value * 100)}%` };

/** Shared by every per-cast kind so they cannot drift apart in maths or in voice. */
interface BoundedCasts {
  values: { timeS: number; value: number }[];
  bound: 'min' | 'max';
  scale: Scale;
  /** The chip and the sentence both build off this and `phrase`, so neither can drift from the other. */
  subject: string;
  phrase: (limit: string) => string;
  /** Sentence-only, for a consequence the chip has no room for. */
  tail?: string;
}

function evaluateBoundedPerCast(
  judged: BoundedCasts, threshold: RuleThreshold, severity: Severity, remedy?: string,
): AnalysisFinding | null {
  if (!judged.values.length) return null;
  const limit = judged.scale.quantize(lenient(threshold, judged.bound === 'min' ? 'down' : 'up'));
  const violations = judged.values.filter(({ value }) => judged.bound === 'min' ? value < limit : value > limit);
  if (!violations.length) return null;
  const phrase = judged.phrase(judged.scale.format(limit));
  return {
    severity, category: 'rule_violation',
    timestamp_ms: Math.round(violations[0].timeS * 1000),
    label: `${judged.subject} ${phrase}`,
    message: `${judged.subject} cast ${phrase}${judged.tail ?? ''}, ${violations.length} of ${judged.values.length} cast(s). Top: ${judged.scale.format(threshold.value)}.`,
    measured: { value: `${violations.length} / ${judged.values.length}`, unit: 'cast(s)' },
    details: remedy ? { remedy } : undefined,
  };
}

export function evaluateCastAtTargetCount(
  cond: CastAtTargetCountCondition, ctx: RuleContext, threshold: RuleThreshold, severity: Severity, remedy?: string,
): AnalysisFinding | null {
  return evaluateBoundedPerCast({
    values: targetCountsPerCast(cond, ctx).map(({ timeS, targets }) => ({ timeS, value: targets })),
    bound: cond.bound,
    scale: WHOLE_STEPS,
    subject: cond.spell_name,
    phrase: limit => `at ${cond.bound === 'min' ? 'under' : 'over'} ${limit} targets`,
  }, threshold, severity, remedy);
}

/** A share of the pool's own cap, so one threshold stays meaningful across pools whose scales differ by orders of magnitude. */
function resourceFractionPerCast(cond: ResourceAtCastCondition, ctx: RuleContext): { timeS: number; frac: number }[] {
  const judged: { timeS: number; frac: number }[] = [];
  for (const event of ctx.castEvents) {
    if (event.type !== 'cast' || event.abilityGameID !== cond.spell_id) continue;
    if (event.resourceActor != null && event.resourceActor !== RESOURCE_ACTOR_SOURCE) continue;
    const pool = event.classResources?.find(resource => resource.type === cond.resource_type);
    if (!pool?.max) continue;
    judged.push({ timeS: (event.timestamp - ctx.fStart) / 1000, frac: pool.amount / pool.max });
  }
  return judged;
}

export function evaluateResourceAtCast(
  cond: ResourceAtCastCondition, ctx: RuleContext, threshold: RuleThreshold, severity: Severity, remedy?: string,
): AnalysisFinding | null {
  return evaluateBoundedPerCast({
    values: resourceFractionPerCast(cond, ctx).map(({ timeS, frac }) => ({ timeS, value: frac })),
    bound: cond.bound,
    scale: PERCENT,
    subject: cond.spell_name,
    phrase: limit => `${cond.bound === 'min' ? 'below' : 'above'} ${limit} ${cond.resource_name}`,
  }, threshold, severity, remedy);
}

/** A proc still up when the pull ends has not been wasted, whether the log closed its span at the kill or left it open. */
function closedProcSpans(cond: ProcWastedCondition, ctx: RuleContext): [number, number | null][] {
  return (ctx.selfAuras.get(cond.buff_spell_id) ?? [])
    .filter(([, end]) => end != null && end < ctx.fightDurationS * 1000);
}

export function evaluateProcWasted(
  cond: ProcWastedCondition, ctx: RuleContext, severity: Severity, remedy?: string,
): AnalysisFinding | null {
  const spans = closedProcSpans(cond, ctx);
  if (!spans.length) return null;
  const spendTimes = cond.spend_spell_ids.flatMap(spellId => ctx.castTimes[spellId] ?? []);
  const wasted = spans.filter(([startMs, endMs]) =>
    !spendTimes.some(time => time * 1000 >= startMs && time * 1000 <= (endMs as number)));
  if (!wasted.length) return null;
  return {
    severity, category: 'rule_violation',
    timestamp_ms: Math.round(wasted[0][0]),
    label: `${cond.buff_spell_name} wasted`,
    message: `${cond.buff_spell_name} expired unspent ${wasted.length} of ${spans.length} time(s).`,
    measured: { value: `${wasted.length} / ${spans.length}`, unit: 'proc(s)' },
    details: remedy ? { remedy } : undefined,
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
  split: FillerSplit, threshold: RuleThreshold, severity: Severity,
  spellName: string, where: string, remedy?: string,
): AnalysisFinding | null {
  const share = fillerShare(split);
  if (share == null || share >= lenient(threshold, 'down')) return null;
  return {
    severity, category: 'rule_violation',
    timestamp_ms: split.firstAlternativeS == null ? undefined : Math.round(split.firstAlternativeS * 1000),
    label: `${spellName} ${where}`,
    message: `${spellName} was ${Math.round(share * 100)}% of your fillers ${where}. Top: ${Math.round(threshold.value * 100)}%.`,
    measured: { value: `${Math.round(share * 100)} / ${Math.round(threshold.value * 100)}`, unit: '% of fillers' },
    details: remedy ? { remedy } : undefined,
  };
}

function fillerCastsInBuff(cond: FillerInBuffCondition, ctx: RuleContext): FillerSplit {
  return splitFillers(cond.spell_id, cond.alternative_spell_ids, spellId =>
    (ctx.castTimes[spellId] ?? []).filter(time =>
      auraAlreadyUpAt(ctx.selfAuras, cond.buff_spell_id, time * 1000)
      && !suspendedAt(cond.except_buff_spell_ids, ctx, time * 1000)));
}

export function evaluateFillerInBuff(
  cond: FillerInBuffCondition, ctx: RuleContext, threshold: RuleThreshold, severity: Severity, remedy?: string,
): AnalysisFinding | null {
  return fillerFinding(fillerCastsInBuff(cond, ctx), threshold, severity,
    cond.spell_name, `in ${cond.buff_spell_name}`, remedy);
}

/** A state the rule agreed not to judge under, so a window the sources say to press the other button in is not counted against the player. */
function suspendedAt(exceptIds: number[] | undefined, ctx: RuleContext, timeMs: number): boolean {
  return (exceptIds ?? []).some(spellId => auraUpAt(ctx.selfAuras, spellId, timeMs));
}

/** A stack count is only readable once the buff has been seen, so a pull on a build without it measures nothing. */
function stackCountsPerCast(cond: SpendAtStacksCondition, ctx: RuleContext): { timeS: number; stacks: number }[] {
  const timeline = ctx.stacks(cond.buff_spell_id);
  if (!timeline.length) return [];
  return [...(ctx.castTimes[cond.spell_id] ?? [])].sort((a, b) => a - b)
    .filter(timeS => !suspendedAt(cond.except_buff_spell_ids, ctx, timeS * 1000))
    .map(timeS => ({ timeS, stacks: stacksAt(timeline, timeS * 1000) }));
}

export function evaluateSpendAtStacks(
  cond: SpendAtStacksCondition, ctx: RuleContext, threshold: RuleThreshold, severity: Severity, remedy?: string,
): AnalysisFinding | null {
  // Over the bar is overcapping, which is what a player sees; under it is spending cheap.
  const wording = cond.bound === 'min' ? 'under' : 'over';
  return evaluateBoundedPerCast({
    values: stackCountsPerCast(cond, ctx).map(({ timeS, stacks }) => ({ timeS, value: stacks })),
    bound: cond.bound,
    scale: WHOLE_STEPS,
    subject: cond.spell_name,
    phrase: limit => `at ${wording} ${limit} ${cond.buff_spell_name}`,
    tail: cond.bound === 'max' ? ', overcapping' : undefined,
  }, threshold, severity, remedy);
}

type ClosedSpan = AuraSpan & { endMs: number };

/** Narrows in one place, so the spans that ran to an end are handled without asserting on every read. */
function closedSpans(perTarget: AuraSpansByTarget): ClosedSpan[] {
  return [...perTarget.values()].flat().filter((span): span is ClosedSpan => span.endMs != null);
}

function clipSpans(cond: AuraClippedCondition, ctx: RuleContext): AuraSpansByTarget {
  return cond.on === 'target' ? ctx.targetSpans(cond.aura_spell_id) : ctx.selfSpans(cond.aura_spell_id);
}

/** Only a re-application the player cast counts, since most refreshes in a log are procs rather than presses. */
function hardCastRefreshes(cond: AuraClippedCondition, ctx: RuleContext): ClosedSpan[] {
  const castTimes = ctx.castTimes[cond.cast_spell_id] ?? [];
  // One-sided: a cast after the refresh cannot have caused it.
  const cast = (atMs: number) => castTimes.some(time =>
    atMs - time * 1000 >= 0 && atMs - time * 1000 <= HARD_CAST_WINDOW_S * 1000);
  return closedSpans(clipSpans(cond, ctx))
    .filter(span => span.endedByRefresh && cast(span.endMs)
      && !suspendedAt(cond.except_buff_spell_ids, ctx, span.endMs));
}

/** Needs no authored duration, so neither a death-truncated span nor a pandemic-extended one can skew it. */
function elapsedAtRefresh(cond: AuraClippedCondition, ctx: RuleContext): { timeS: number; elapsedS: number }[] {
  return hardCastRefreshes(cond, ctx)
    .map(span => ({ timeS: span.endMs / 1000, elapsedS: (span.endMs - span.startMs) / 1000 }))
    .sort((a, b) => a.timeS - b.timeS);
}

export function evaluateAuraClipped(
  cond: AuraClippedCondition, ctx: RuleContext, threshold: RuleThreshold, severity: Severity, remedy?: string,
): AnalysisFinding | null {
  const judged = elapsedAtRefresh(cond, ctx);
  if (!judged.length) return null;
  const floor = lenient(threshold, 'down');
  const clipped = judged.filter(({ elapsedS }) => elapsedS < floor);
  if (!clipped.length) return null;
  return {
    severity, category: 'rule_violation',
    timestamp_ms: Math.round(clipped[0].timeS * 1000),
    label: `${cond.aura_spell_name} clipped`,
    message: `${cond.aura_spell_name} re-applied a median ${round(median(clipped.map(entry => entry.elapsedS)) ?? 0, 1)}s in, ${clipped.length} of ${judged.length} refresh(es). Top: ${round(threshold.value, 1)}s.`,
    measured: { value: `${clipped.length} / ${judged.length}`, unit: 'refresh(es)' },
    details: remedy ? { remedy } : undefined,
  };
}

/** Health rides on damage rows rather than casts, so a cast reads the latest snapshot of THE ENEMY IT NAMED - a tick on a dying add otherwise licenses an execute against a full-health boss. */
function targetHealthFracAt(ctx: RuleContext, cast: WclEvent): number | null {
  const rows = ctx.targetHealth(targetKey(cast));
  const latest = partitionPoint(rows.length, index => rows[index][0] > cast.timestamp) - 1;
  if (latest < 0 || rows[latest][0] < cast.timestamp - HEALTH_SAMPLE_WINDOW_S * 1000) return null;
  return rows[latest][1];
}

function fillersBelowHealth(cond: FillerBelowHealthCondition, ctx: RuleContext): FillerSplit {
  const gate = cond.health_pct / 100;
  return splitFillers(cond.spell_id, cond.alternative_spell_ids, spellId => ctx.castEvents
    .filter(event => {
      if (event.type !== 'cast' || event.abilityGameID !== spellId) return false;
      if (suspendedAt(cond.except_buff_spell_ids, ctx, event.timestamp - ctx.fStart)) return false;
      const frac = targetHealthFracAt(ctx, event);
      return frac != null && frac <= gate;
    })
    .map(event => (event.timestamp - ctx.fStart) / 1000));
}

export function evaluateFillerBelowHealth(
  cond: FillerBelowHealthCondition, ctx: RuleContext, threshold: RuleThreshold, severity: Severity, remedy?: string,
): AnalysisFinding | null {
  return fillerFinding(fillersBelowHealth(cond, ctx), threshold, severity,
    cond.spell_name, `under ${cond.health_pct}% health`, remedy);
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
export type RuleStream = 'enemyAuras' | 'damage' | 'deaths' | 'targetHealth';

/** One kind's facts in one block, so adding a kind is one edit rather than one per dispatch site. */
interface KindSpec<C extends RuleCondition> {
  streams: (cond: C) => RuleStream[];
  /** Null for a kind that judges against the rulebook alone, so the encounter benches nothing for it. */
  measure: ((cond: C, ctx: RuleContext) => number | null) | null;
  evaluate: (
    cond: C, ctx: RuleContext, threshold: RuleThreshold | null, severity: Severity, remedy?: string,
  ) => AnalysisFinding | null;
  applicable: (cond: C, ctx: RuleContext) => boolean;
  label: (cond: C) => string;
}

/** Lifts an evaluator that needs a magnitude, so a rule the encounter could not bench judges nothing. */
function withThreshold<C extends RuleCondition>(
  evaluate: (cond: C, ctx: RuleContext, threshold: RuleThreshold, severity: Severity, remedy?: string) => AnalysisFinding | null,
): KindSpec<C>['evaluate'] {
  return (cond, ctx, threshold, severity, remedy) => threshold && evaluate(cond, ctx, threshold, severity, remedy);
}

/** Keyed by kind, so a new condition cannot compile until it declares all five. */
const RULE_KINDS: { [K in RuleCondition['kind']]: KindSpec<Extract<RuleCondition, { kind: K }>> } = {
  cast_without_prior: {
    streams: () => [],
    measure: (cond, ctx) => {
      // The widest lead the parse actually needed, so the window covers how loosely the field pairs them.
      const leads = leadPerCast(cond, ctx.castTimes).filter((lead): lead is number => lead != null);
      return leads.length ? Math.max(...leads) : null;
    },
    evaluate: withThreshold(evaluateCastWithoutPrior),
    applicable: (cond, ctx) => castCount(ctx, cond.spell_id) > 0,
    label: cond => `${cond.spell_name} with ${cond.required_spell_name}`,
  },
  hold_cooldown_for_anchor: {
    streams: () => [],
    measure: (cond, ctx) => {
      // The closest the parse came to spending before an anchor, which is the gap it kept clear.
      const gaps = holdAnchors(cond, ctx.castTimes).flatMap(anchorTime => cond.spell_ids
        .flatMap(spellId => ctx.castTimes[spellId] ?? [])
        .filter(castTime => castTime < anchorTime)
        .map(castTime => anchorTime - castTime));
      return gaps.length ? Math.min(...gaps) : null;
    },
    evaluate: withThreshold(evaluateHoldForAnchor),
    applicable: (cond, ctx) => holdAnchors(cond, ctx.castTimes).length > 0
      && cond.spell_ids.some(spellId => castCount(ctx, spellId) > 0),
    label: cond => `${cond.spell_names.join('/')} held for ${cond.anchor_spell_name}`,
  },
  cast_outside_buff: {
    streams: () => [],
    measure: null,
    evaluate: (cond, ctx, _threshold, severity, remedy) => evaluateCastOutsideBuff(cond, ctx, severity, remedy),
    applicable: (cond, ctx) => castCount(ctx, cond.spell_id) > 0,
    label: cond => `${cond.spell_name} ${cond.require} ${cond.buff_spell_name}`,
  },
  aura_uptime_below: {
    streams: cond => cond.on === 'target' ? ['enemyAuras', 'deaths'] : ['deaths'],
    measure: (cond, ctx) => uptimePct(cond, ctx) || null,
    evaluate: withThreshold(evaluateAuraUptimeBelow),
    applicable: (cond, ctx) => uptimePct(cond, ctx) > 0,
    label: cond => `${cond.aura_spell_name} uptime`,
  },
  opening_sequence: {
    streams: () => [],
    // Measured against the whole pull, since the window being derived cannot gate its own measurement.
    measure: (cond, ctx) => openerProgress(cond, ctx, ctx.fightDurationS)?.completedS ?? null,
    evaluate: withThreshold(evaluateOpeningSequence),
    applicable: (cond, ctx) => cond.spell_ids.some(spellId => castCount(ctx, spellId) > 0),
    label: cond => `Opener: ${cond.spell_names.join(' > ')}`,
  },
  cast_at_target_count: {
    streams: () => ['damage'],
    measure: (cond, ctx) => {
      const counts = targetCountsPerCast(cond, ctx).map(entry => entry.targets);
      return counts.length ? median(counts) ?? null : null;
    },
    evaluate: withThreshold(evaluateCastAtTargetCount),
    applicable: (cond, ctx) => targetCountsPerCast(cond, ctx).length > 0,
    label: cond => `${cond.spell_name} target count`,
  },
  resource_at_cast: {
    streams: () => [],
    measure: (cond, ctx) => {
      const fracs = resourceFractionPerCast(cond, ctx).map(entry => entry.frac);
      return fracs.length ? median(fracs) ?? null : null;
    },
    evaluate: withThreshold(evaluateResourceAtCast),
    applicable: (cond, ctx) => resourceFractionPerCast(cond, ctx).length > 0,
    label: cond => `${cond.spell_name} at ${cond.resource_name}`,
  },
  proc_wasted: {
    streams: () => [],
    measure: null,
    evaluate: (cond, ctx, _threshold, severity, remedy) => evaluateProcWasted(cond, ctx, severity, remedy),
    applicable: (cond, ctx) => closedProcSpans(cond, ctx).length > 0,
    label: cond => `${cond.buff_spell_name} spent`,
  },
  filler_in_buff: {
    streams: () => [],
    measure: (cond, ctx) => fillerShare(fillerCastsInBuff(cond, ctx)),
    evaluate: withThreshold(evaluateFillerInBuff),
    applicable: (cond, ctx) => fillerCastsInBuff(cond, ctx).total > 0,
    label: cond => `${cond.spell_name} in ${cond.buff_spell_name}`,
  },
  spend_at_stacks: {
    streams: () => [],
    measure: (cond, ctx) => {
      // The cheapest spend the parse allowed, not its typical one: a median would put half the field's own casts on the wrong side of the bar.
      const counts = stackCountsPerCast(cond, ctx).map(entry => entry.stacks);
      if (!counts.length) return null;
      return cond.bound === 'min' ? Math.min(...counts) : Math.max(...counts);
    },
    evaluate: withThreshold(evaluateSpendAtStacks),
    applicable: (cond, ctx) => stackCountsPerCast(cond, ctx).length > 0,
    label: cond => `${cond.spell_name} at ${cond.buff_spell_name}`,
  },
  aura_clipped: {
    streams: cond => cond.on === 'target' ? ['enemyAuras'] : [],
    measure: (cond, ctx) => {
      // The earliest the parse re-applied, the same forgiving extreme read from the other end.
      const elapsed = elapsedAtRefresh(cond, ctx).map(entry => entry.elapsedS);
      return elapsed.length ? Math.min(...elapsed) : null;
    },
    evaluate: withThreshold(evaluateAuraClipped),
    applicable: (cond, ctx) => elapsedAtRefresh(cond, ctx).length > 0,
    label: cond => `${cond.aura_spell_name} clipped`,
  },
  filler_below_health: {
    streams: () => ['damage', 'targetHealth'],
    measure: (cond, ctx) => fillerShare(fillersBelowHealth(cond, ctx)),
    evaluate: withThreshold(evaluateFillerBelowHealth),
    applicable: (cond, ctx) => fillersBelowHealth(cond, ctx).total > 0,
    label: cond => `${cond.spell_name} under ${cond.health_pct}% health`,
  },
};

/** The engine's one cast: the table is keyed by `kind`, so an entry always matches the condition that looked it up. */
function specFor<C extends RuleCondition>(cond: C): KindSpec<C> {
  return RULE_KINDS[cond.kind] as unknown as KindSpec<C>;
}

export function rulesNeed(rules: RulebookRule[], stream: RuleStream): boolean {
  return rules.some(rule => specFor(rule.condition).streams(rule.condition).includes(stream));
}

/** A deployed rulebook file can still carry a rule with no condition, which the engine has nothing to judge. */
export function judgeableRules(rules: RulebookRule[]): RulebookRule[] {
  return rules.filter(rule => rule.condition != null);
}

export function measureRule(cond: RuleCondition, ctx: RuleContext): number | null {
  return specFor(cond).measure?.(cond, ctx) ?? null;
}

/** Null when too few parses could supply a magnitude, so a thin sample never sets the bar. */
export function ruleThreshold(
  samples: (number | null)[], parseCount: number,
): { threshold: RuleThreshold | null; sample_count: number } {
  const measured = samples.filter((sample): sample is number => sample != null);
  if (!measured.length || measured.length < parseCount * THRESHOLD_SAMPLE_FRAC) {
    return { threshold: null, sample_count: measured.length };
  }
  const value = median(measured) ?? 0;
  const band = Math.max(deviation(measured) ?? 0, Math.abs(value) * THRESHOLD_BAND_MIN_FRAC);
  return { threshold: { value, band }, sample_count: measured.length };
}

export function benchedRules(benched: BenchedRule[]): BenchedRule[] {
  return benched.filter(entry => entry.rule.condition != null
    && (specFor(entry.rule.condition).measure == null || entry.threshold != null));
}

export function evaluateCondition(
  cond: RuleCondition, ctx: RuleContext, threshold: RuleThreshold | null, severity: Severity, remedy?: string,
): AnalysisFinding | null {
  return specFor(cond).evaluate(cond, ctx, threshold, severity, remedy);
}

/** Whether the pull gave the player any chance to break the rule; without this a rule reads as followed on a fight it never came up in. */
export function ruleApplicable(cond: RuleCondition, ctx: RuleContext): boolean {
  return specFor(cond).applicable(cond, ctx);
}

export function evaluateRules(benched: BenchedRule[], ctx: RuleContext): AnalysisFinding[] {
  const findings: AnalysisFinding[] = [];
  for (const { rule, threshold } of benched) {
    // The gate rulesFollowed uses, so a rule the pull never tested lands in neither state instead of reading as broken.
    if (!ruleApplicable(rule.condition, ctx)) continue;
    const finding = evaluateCondition(rule.condition, ctx, threshold, rule.severity, rule.action);
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
  for (const { rule, threshold } of benched) {
    const cond = rule.condition;
    if (!ruleApplicable(cond, ctx)) continue;
    if (!evaluateCondition(cond, ctx, threshold, rule.severity)) {
      followed.push(ruleLabel(cond, rule.description));
    }
  }
  return followed;
}
