/**
 * Rotation slice runtime shell + its pure analysis functions, colocated.
 *
 * `RotationFeatureService` is the imperative shell (each component injects only
 * it). It is dual-mode:
 *
 * - Post-raid (`loadPlayerView`): fetches the player's own log (report master
 *   abilities for icons + Casts/Buffs events), reads the prepared rotation bench
 *   via the swappable `ROTATION_DATA_SOURCE`, and produces the offensive findings
 *   (split into needs-improvement / timing-suggestions / doing-well) plus the
 *   per-cooldown comparison rows.
 * - Pre-fight (`loadPlanView`): bench-only, returns the cooldown-plan rows.
 *
 * Per the slice rule it imports ONLY the two API services + its data-source token
 * + models + `logWarn`, and reimplements all of its analysis math as named, pure,
 * total functions below (it does NOT import core/analysis). Duplication with the
 * legacy cooldown-analysis / rule-engine is expected and accepted.
 */
import { Injectable, inject } from '@angular/core';
import { WclApiService } from '../../../core/services/wcl-api';
import { AnalysisFinding } from '../../../core/models/analysis.models';
import { PerCdBenchmark } from '../../../core/models/encounter.models';
import {
  RulebookCooldown, RulebookRule, RuleCondition,
  CastWithoutPriorCondition, HoldCooldownForAnchorCondition,
} from '../../../core/models/rulebook.models';
import { WclEvent } from '../../../core/models/wcl.models';
import { logWarn } from '../../../core/log';
import {
  isOutlierAbove, isOutlierBeyond, isCriticallyBelow, castEfficiencyPct,
  closestToZero, benchExpectedUses, fmtClock, sortBySeverity,
} from '../../../shared/analysis/analysis-math';
import { ROTATION_DATA_SOURCE, RotationBench } from './rotation-data-source';

export type Severity = AnalysisFinding['severity'];

/** Spell id -> baked icon + name, complete over every spell the card renders. */
export type AbilityIcons = Record<number, { icon: string; name: string }>;

/** One row of the flat finding table (severity / what / measured / fix). */
export interface RotationFindingRow {
  severity: 'critical' | 'warning';
  /** Display name for cooldown rows; empty for rule rows (which render `what`). */
  name: string;
  spellId?: number | null;
  /** Baked icon filename for `wl-game-icon` (empty string when there is no art). */
  icon: string;
  timestampMs?: number | null;
  chip?: string;
  what?: string;
  measured: { value: string; unit?: string };
  fix?: string;
}

/** A cooldown used cleanly, shown as an "on plan" chip rather than a row. */
export interface RotationOnPlanChip {
  name: string;
  spellId: number | null;
  /** Baked icon filename for `wl-game-icon` (empty string when there is no art). */
  icon: string;
}

/** Pre-fight cooldown-plan row. */
export interface CdPlanRow {
  name: string;
  spellId: number | null;
  /** Baked icon filename for `wl-game-icon` (empty string when there is no art). */
  icon: string;
  firstCastS: number | null;
  uses: number | null;
  usesPerMin: number | null;
  bloodlust: boolean;
  bloodlustPct: number | null;
  holds: { castIndex: number; targetS: number }[];
  rule: string | null;
}

/** Post-raid rotation view-model. */
export interface RotationPlayerView {
  ruleRows: RotationFindingRow[];
  /** Labels of rotation rules the player followed cleanly this fight. */
  ruleOnPlan: string[];
  offensiveRows: RotationFindingRow[];
  onPlan: RotationOnPlanChip[];
}

/** Bloodlust ids + window grace (mirrors the analysis format module). */
const BLOODLUST_IDS = new Set([2825, 32182, 80353, 90355, 264667, 390386]);
const BLOODLUST_DURATION_S = 40;
// BL alignment window around the BL apply: a cast from BL_WINDOW_LEAD_S before the
// pull of BL through BL_WINDOW_TRAIL_S after the buff expires counts as aligned.
const BL_WINDOW_LEAD_S = 30;
const BL_WINDOW_TRAIL_S = 15;
/** A cooldown is treated as Bloodlust-aligned when at least this share (%) of top parses align it. */
const BL_CONSENSUS_PCT = 50;

/* ----------------------------- rule engine (ported) ----------------------------- */

export type CastTimes = Record<number, number[]>;

/** Build the spell-id -> fight-relative cast-time index the rules consume. */
export function buildCastTimes(casts: WclEvent[], fStart: number): CastTimes {
  const castTimes: CastTimes = {};
  for (const cast of casts) {
    if (cast.type === 'cast' && cast.abilityGameID) {
      (castTimes[cast.abilityGameID] ??= []).push((cast.timestamp - fStart) / 1000);
    }
  }
  return castTimes;
}

/** Evaluate one `cast_without_prior` condition. Returns a finding or null. */
export function evaluateCastWithoutPrior(
  cond: CastWithoutPriorCondition, castTimes: CastTimes, severity: Severity, remedy?: string,
): AnalysisFinding | null {
  const win = cond.window_s ?? 5;
  const exception = cond.exception;
  const primary = [...(castTimes[cond.spell_id] ?? [])].sort((a, b) => a - b);
  const required = castTimes[cond.required_spell_id] ?? [];
  const violations: number[] = [];
  for (const time of primary) {
    if (required.some(rt => Math.abs(time - rt) <= win)) continue;
    if (exception) {
      const context = castTimes[exception.context_spell_id] ?? [];
      const contextWindow = exception.context_window_s ?? 20;
      const covered = exception.position === 'before'
        ? context.some(ct => time - ct >= 0 && time - ct <= contextWindow)
        : context.some(ct => ct - time >= 0 && ct - time <= contextWindow);
      if (covered) continue;
    }
    violations.push(time);
  }
  if (!violations.length) return null;
  return {
    severity, category: 'rule_violation',
    timestamp_ms: Math.round(violations[0] * 1000),
    label: `${cond.spell_name} without ${cond.required_spell_name}`,
    message: `${cond.spell_name} without ${cond.required_spell_name}: ${violations.length} of ${primary.length} cast(s).`,
    measured: { value: `${violations.length} / ${primary.length}`, unit: 'cast(s)' },
    details: remedy ? { remedy } : undefined,
  };
}

/** Evaluate one `hold_cooldown_for_anchor` condition. Returns a finding or null. */
export function evaluateHoldForAnchor(
  cond: HoldCooldownForAnchorCondition, castTimes: CastTimes, severity: Severity, remedy?: string,
): AnalysisFinding | null {
  const holdWindowS = cond.hold_window_s ?? 15;
  const anchorTimes = [...(castTimes[cond.anchor_spell_id] ?? [])].sort((a, b) => a - b).slice(1);
  const violations = cond.spell_ids.flatMap((spellId, i) => {
    const spellName = cond.spell_names?.[i] ?? String(spellId);
    return anchorTimes.flatMap(anchorTime =>
      (castTimes[spellId] ?? [])
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
    message: `${spellNames} used in the ${holdWindowS}s hold window before ${cond.anchor_spell_name}: ${violations.length} charge(s).`,
    measured: { value: `${violations.length}`, unit: 'charge(s)' },
    details: remedy ? { remedy } : undefined,
  };
}

/** Evaluate every rule's condition against the cast stream. */
export function evaluateRules(rules: RulebookRule[], casts: WclEvent[], fStart: number): AnalysisFinding[] {
  const findings: AnalysisFinding[] = [];
  const castTimes = buildCastTimes(casts, fStart);
  for (const rule of rules) {
    const cond = rule.condition;
    if (!cond) continue;
    const severity: Severity = rule.priority === 'critical' ? 'critical' : 'warning';
    const finding = cond.kind === 'cast_without_prior'
      ? evaluateCastWithoutPrior(cond, castTimes, severity, rule.action)
      : cond.kind === 'hold_cooldown_for_anchor'
        ? evaluateHoldForAnchor(cond, castTimes, severity, rule.action)
        : null;
    if (finding) findings.push(finding);
  }
  return findings;
}

/** Positive on-plan label for a rule: its description, else a phrasing of the condition. */
export function ruleLabel(cond: RuleCondition, description?: string): string {
  if (description) return description;
  return cond.kind === 'cast_without_prior'
    ? `${cond.spell_name} with ${cond.required_spell_name}`
    : `${cond.spell_names.join('/')} held for ${cond.anchor_spell_name}`;
}

/** Labels of rules the player exercised this fight and followed cleanly (no violation). */
export function rulesFollowed(rules: RulebookRule[], casts: WclEvent[], fStart: number): string[] {
  const castTimes = buildCastTimes(casts, fStart);
  const followed: string[] = [];
  for (const rule of rules) {
    const cond = rule.condition;
    if (!cond) continue;
    const severity: Severity = rule.priority === 'critical' ? 'critical' : 'warning';
    if (cond.kind === 'cast_without_prior') {
      const applicable = (castTimes[cond.spell_id]?.length ?? 0) > 0;
      if (applicable && !evaluateCastWithoutPrior(cond, castTimes, severity)) followed.push(ruleLabel(cond, rule.description));
    } else if (cond.kind === 'hold_cooldown_for_anchor') {
      const applicable = (castTimes[cond.anchor_spell_id]?.length ?? 0) > 1
        && cond.spell_ids.some(spellId => (castTimes[spellId]?.length ?? 0) > 0);
      if (applicable && !evaluateHoldForAnchor(cond, castTimes, severity)) followed.push(ruleLabel(cond, rule.description));
    }
  }
  return followed;
}

/* ----------------------------- offensive cooldown analysis (ported) ----------------------------- */

/** Idle-time floor (s) below which low cast efficiency is not worth surfacing. */
const MIN_IDLE_FOR_EFFICIENCY_S = 5;

/** The named inputs `analyzeRotationFindings` scans (replaces 7 positional args). */
export interface RotationScanInput {
  fStart: number;
  fEnd: number;
  castEvents: WclEvent[];
  buffEvents: WclEvent[];
  cooldowns: RulebookCooldown[];
  rules: RulebookRule[];
  bench: RotationBench;
}

/** Per-cooldown findings + whether the cooldown landed in the Bloodlust window. */
interface CooldownScan { issues: AnalysisFinding[]; holds: AnalysisFinding[]; blAligned: boolean; }

/** Lost-cooldown critical when a cooldown is unused or under the floor. Null if on plan. */
export function checkLostUses(
  cdName: string, actual: number, expected: number, floor: number, fightDurS: number,
): AnalysisFinding | null {
  if (actual === 0 && expected >= 1) return {
    severity: 'critical', category: 'lost_cooldown', cd_name: cdName,
    measured: { value: `0 / ${expected}`, unit: 'cast(s)' },
    message: `${cdName} unused. Expected ${expected} on a ${fmtClock(fightDurS)} fight.`,
    details: { remedy: `Use ${cdName} ${expected}x this fight.` } };
  if (actual > 0 && actual < floor) return {
    severity: 'critical', category: 'lost_cooldown', cd_name: cdName,
    measured: { value: `${actual} / ${expected}`, unit: 'cast(s)' },
    message: `${cdName}: ${actual} casts, expected ${expected}. ${floor - actual} lost.`,
    details: { remedy: `Press ${cdName} ${floor - actual}x more - sooner off cooldown.` } };
  return null;
}

/** Late-opener warning when the first cast sits >2 sigma past the top first-cast. Null otherwise. */
export function checkFirstCastDelay(
  cdName: string, castTimesMs: number[], cdBench: PerCdBenchmark,
): AnalysisFinding | null {
  if (!castTimesMs.length) return null;
  const firstS = castTimesMs[0] / 1000;
  if (!isOutlierAbove(firstS, cdBench.avg_first_cast_s, cdBench.stddev_first_cast_s)) return null;
  const lateS = (firstS - cdBench.avg_first_cast_s).toFixed(0);
  return {
    severity: 'warning', category: 'cooldown_delay', cd_name: cdName,
    timestamp_ms: castTimesMs[0],
    measured: { value: `+${lateS}s`, unit: `top ${fmtClock(cdBench.avg_first_cast_s)}` },
    message: `${cdName} opened at ${fmtClock(firstS)}, ${lateS}s late. Top: ${fmtClock(cdBench.avg_first_cast_s)}.`,
    details: { remedy: `Open with ${cdName} earlier.` } };
}

/**
 * Bloodlust alignment: whether the cooldown landed in the BL window, plus the
 * miss (when top parses align it) or in-window offset warning.
 */
export function checkBloodlustAlignment(
  cdName: string, castTimesMs: number[], cdBench: PerCdBenchmark, blTimeS: number | null, wantsBL: boolean,
): { blAligned: boolean; findings: AnalysisFinding[] } {
  if (blTimeS === null || !castTimesMs.length) return { blAligned: false, findings: [] };
  const inWindow = castTimesMs.filter(timeMs => {
    const timeS = timeMs / 1000;
    return timeS >= blTimeS - BL_WINDOW_LEAD_S && timeS <= blTimeS + BLOODLUST_DURATION_S + BL_WINDOW_TRAIL_S;
  });
  const blAligned = inWindow.length > 0;
  const findings: AnalysisFinding[] = [];
  if (!blAligned && wantsBL) {
    findings.push({ severity: 'critical', category: 'cooldown_alignment', cd_name: cdName,
      timestamp_ms: castTimesMs[0],
      measured: { value: 'missed', unit: 'BL' },
      message: `${cdName} missed Bloodlust (BL at ${fmtClock(blTimeS)}, first cast at ${fmtClock(castTimesMs[0] / 1000)}).`,
      details: { remedy: `Align ${cdName} with Bloodlust.` } });
  } else if (blAligned && cdBench.avg_bl_offset_s != null && cdBench.stddev_bl_offset_s != null) {
    const offsets = inWindow.map(timeMs => timeMs / 1000 - blTimeS);
    const playerOffset = closestToZero(offsets);
    if (isOutlierBeyond(playerOffset, cdBench.avg_bl_offset_s, cdBench.stddev_bl_offset_s)) {
      const dir = playerOffset > cdBench.avg_bl_offset_s ? 'late' : 'early';
      findings.push({ severity: 'warning', category: 'cooldown_alignment', cd_name: cdName,
        timestamp_ms: inWindow[0],
        measured: { value: dir, unit: 'in BL' },
        message: `${cdName} ${dir} in the Bloodlust window.`,
        details: { remedy: `Tighten ${cdName} to the Bloodlust window.` } });
    }
  }
  return { blAligned, findings };
}

/** Held-past-reset warnings: each inter-cast gap >2 sigma above the top gap. */
export function checkGaps(cdName: string, castTimesMs: number[], cdBench: PerCdBenchmark): AnalysisFinding[] {
  const findings: AnalysisFinding[] = [];
  if (cdBench.avg_gap_s == null || cdBench.stddev_gap_s == null) return findings;
  for (let i = 1; i < castTimesMs.length; i++) {
    const gap = (castTimesMs[i] - castTimesMs[i - 1]) / 1000;
    if (isOutlierAbove(gap, cdBench.avg_gap_s, cdBench.stddev_gap_s)) findings.push({
      severity: 'warning', category: 'cooldown_delay', cd_name: cdName,
      timestamp_ms: castTimesMs[i],
      measured: { value: `${gap.toFixed(0)}s`, unit: `avg ${cdBench.avg_gap_s.toFixed(0)}s` },
      message: `${cdName} at ${fmtClock(castTimesMs[i] / 1000)}: ${gap.toFixed(0)}s gap, top ${cdBench.avg_gap_s.toFixed(0)}s.`,
      details: { remedy: `Press ${cdName} sooner - top gap ${cdBench.avg_gap_s.toFixed(0)}s.` } });
  }
  return findings;
}

/** Hold suggestions: flag an under-hold clearly below the consensus band (over-holding tolerated). */
export function checkHoldSuggestions(cdName: string, castTimesMs: number[], cdBench: PerCdBenchmark): AnalysisFinding[] {
  const findings: AnalysisFinding[] = [];
  if (!castTimesMs.length) return findings;
  const times = castTimesMs.map(timeMs => timeMs / 1000);
  for (const [idxStr, target] of Object.entries(cdBench.hold_targets)) {
    const index = parseInt(idxStr, 10) - 1;
    // Need a prior cast to measure a gap; index 0 has none.
    if (index < 1 || index >= times.length) continue;
    // PR1 transition guard: pre-v2 hold targets lack the prior-relative band; skip them.
    if (target.effective_cd_s == null || target.band_s == null || target.delay_s == null) continue;
    // Compare the player's OWN gap from their prior cast (cascade-free). Flag only an
    // under-hold clearly below the consensus band; over-holding is tolerated.
    const playerDelay = times[index] - times[index - 1] - target.effective_cd_s;
    if (playerDelay < target.delay_s - target.band_s) findings.push({ severity: 'info', category: 'hold_suggestion',
      timestamp_ms: castTimesMs[index],
      measured: { value: fmtClock(times[index]), unit: `top ${fmtClock(target.target_s)}` },
      message: `${cdName} cast ${idxStr} at ${fmtClock(times[index])}. ${target.count}/${target.total_samples} top parses hold to ${fmtClock(target.target_s)}.`,
      details: { remedy: `Hold ${cdName} to ${fmtClock(target.target_s)}.`, cd_name: cdName } });
  }
  return findings;
}

/** Low-cast-efficiency finding from the player's whole cast stream. Null when efficiency is fine. */
export function checkCastEfficiency(
  castTimesMs: number[], fightDurS: number, bench: RotationBench,
): AnalysisFinding | null {
  if (castTimesMs.length < 2 || bench.downtime_threshold_ms == null) return null;
  let totalDtMs = 0;
  for (let i = 1; i < castTimesMs.length; i++) {
    const gapMs = castTimesMs[i] - castTimesMs[i - 1];
    if (gapMs > bench.downtime_threshold_ms) totalDtMs += gapMs;
  }
  const totalDtS = totalDtMs / 1000;
  if (totalDtS <= MIN_IDLE_FOR_EFFICIENCY_S) return null;
  const topE = bench.top_avg_efficiency;
  const topSD = bench.top_efficiency_stddev;
  const effPct = castEfficiencyPct(totalDtS, fightDurS);
  const severity: Severity = isCriticallyBelow(effPct, topE, topSD) ? 'critical' : 'warning';
  return {
    severity, category: 'cast_efficiency',
    label: 'Low cast efficiency',
    measured: { value: `${effPct.toFixed(1)}%`, unit: `top ${topE.toFixed(0)}%` },
    message: `${effPct.toFixed(1)}% cast efficiency, ${totalDtS.toFixed(1)}s idle. Top: ${topE.toFixed(0)}%.`,
    details: { remedy: `Fill ${totalDtS.toFixed(1)}s of gaps. Top: ${topE.toFixed(0)}%.` } };
}

/**
 * Analyze one cooldown: its lost-use / first-cast / Bloodlust / gap / hold checks.
 * `castTimesMs` are the cooldown's fight-relative cast timestamps (ms, ascending).
 * Returns null when the cooldown is talent-gated and unused (skipped entirely).
 */
export function analyzeOneCooldown(
  cd: RulebookCooldown, castTimesMs: number[], cdBench: PerCdBenchmark | undefined,
  fightDurS: number, blTimeS: number | null,
): { success: AnalysisFinding | null; scan: CooldownScan } | null {
  const cdName = cd.name;
  const actual = castTimesMs.length;
  if (cd.talent_gated && actual === 0) return null;

  if (!cdBench) {
    const success: AnalysisFinding | null = actual > 0
      ? { severity: 'success', category: 'cooldown_usage', cd_name: cdName, message: `${cdName}: ${actual} casts (no bench data).` }
      : null;
    return { success, scan: { issues: [], holds: [], blAligned: false } };
  }

  // BL alignment is data-driven: a cooldown "wants BL" when most top parses align it.
  const wantsBL = cdBench.bl_pct >= BL_CONSENSUS_PCT;
  const { expected, floor } = benchExpectedUses(fightDurS, cdBench.uses_per_min);

  const issues: AnalysisFinding[] = [];
  const lost = checkLostUses(cdName, actual, expected, floor, fightDurS);
  if (lost) issues.push(lost);
  const lateOpener = checkFirstCastDelay(cdName, castTimesMs, cdBench);
  if (lateOpener) issues.push(lateOpener);
  const bl = checkBloodlustAlignment(cdName, castTimesMs, cdBench, blTimeS, wantsBL);
  issues.push(...bl.findings);
  issues.push(...checkGaps(cdName, castTimesMs, cdBench));
  const holds = checkHoldSuggestions(cdName, castTimesMs, cdBench);

  const success: AnalysisFinding | null = issues.length || actual === 0
    ? null
    : { severity: 'success', category: 'cooldown_usage', cd_name: cdName,
        message: `${cdName} - ${actual}/${expected} casts${bl.blAligned && wantsBL ? ', BL-aligned' : ''}.` };
  return { success, scan: { issues, holds, blAligned: bl.blAligned } };
}

/** Produce the offensive `AnalysisFinding[]` (ported from cooldown-analysis). */
export function analyzeRotationFindings(input: RotationScanInput): AnalysisFinding[] {
  const { fStart, fEnd, castEvents, buffEvents, cooldowns, rules, bench } = input;
  const fightDurS = (fEnd - fStart) / 1000;
  const casts = castEvents
    .filter(event => event.type === 'cast' && event.timestamp >= fStart && event.timestamp <= fEnd)
    .sort((a, b) => a.timestamp - b.timestamp);

  const findings: AnalysisFinding[] = [];

  let blTimeS: number | null = null;
  for (const event of buffEvents) {
    if (event.type === 'applybuff' && BLOODLUST_IDS.has(event.abilityGameID) && event.timestamp >= fStart && event.timestamp <= fEnd) {
      blTimeS = (event.timestamp - fStart) / 1000;
      break;
    }
  }

  const perCdBench = bench.per_cd_benchmarks ?? {};
  for (const cd of cooldowns) {
    const castTimesMs = casts
      .filter(cast => cast.abilityGameID === cd.spell_id)
      .map(cast => cast.timestamp - fStart);
    const result = analyzeOneCooldown(cd, castTimesMs, perCdBench[cd.name], fightDurS, blTimeS);
    if (!result) continue;
    if (result.scan.issues.length) findings.push(...result.scan.issues);
    else if (result.success) findings.push(result.success);
    if (castTimesMs.length) findings.push(...result.scan.holds);
  }

  if (rules.length) findings.push(...evaluateRules(rules, casts, fStart));

  const efficiency = checkCastEfficiency(casts.map(cast => cast.timestamp - fStart), fightDurS, bench);
  if (efficiency) findings.push(efficiency);

  sortBySeverity(findings);
  return findings;
}

/* ----------------------------- finding -> row bucketing ----------------------------- */

const CAT_LABEL: Record<string, string> = {
  lost_cooldown: 'lost cast',
  cooldown_delay: 'held',
  cooldown_alignment: 'BL miss',
  cast_efficiency: 'downtime',
  hold_suggestion: 'hold',
};

interface FindingBucket { issues: AnalysisFinding[]; holds: AnalysisFinding[]; }

/** Resolved row identity for a cooldown name (id-less names render as plain text). */
interface ResolvedCd { spellId: number | null; icon: string; rowName: string }

/** Cooldown name + icons -> its spell id + baked icon + display name. */
function resolveCd(name: string, cdSpellIds: Record<string, number>, abilities: AbilityIcons): ResolvedCd {
  const spellId = cdSpellIds[name] ?? null;
  return spellId != null
    ? { spellId, icon: abilities[spellId].icon, rowName: abilities[spellId].name }
    : { spellId: null, icon: '', rowName: name };
}

/** The findings sorted into rule findings, per-cd buckets, and successful-cd names. */
interface PartitionedFindings {
  ruleFindings: AnalysisFinding[];
  byName: Record<string, FindingBucket>;
  successNames: Set<string>;
}

/** Pass 1: split raw findings into rule findings, per-cd issue/hold buckets, and successes. */
export function partitionRotationFindings(findings: AnalysisFinding[]): PartitionedFindings {
  const ruleFindings: AnalysisFinding[] = [];
  const byName: Record<string, FindingBucket> = {};
  const successNames = new Set<string>();
  for (const finding of findings) {
    if (finding.severity === 'success') { if (finding.cd_name) successNames.add(finding.cd_name); continue; }
    if (finding.category === 'hold_suggestion' && finding.details?.cd_name) {
      (byName[finding.details.cd_name] ??= { issues: [], holds: [] }).holds.push(finding);
    } else if (finding.category === 'rule_violation' || !finding.cd_name) {
      ruleFindings.push(finding);
    } else {
      (byName[finding.cd_name] ??= { issues: [], holds: [] }).issues.push(finding);
    }
  }
  return { ruleFindings, byName, successNames };
}

/** Pass 2a: rotation-rule findings -> flat rule rows (rendered by their `what`). */
export function buildRuleRows(ruleFindings: AnalysisFinding[]): RotationFindingRow[] {
  return ruleFindings.map(finding => ({
    severity: finding.severity === 'critical' ? 'critical' : 'warning',
    name: '',
    icon: '',
    what: finding.label,
    measured: finding.measured ?? { value: '-' },
    fix: finding.details?.remedy,
  }));
}

/** Pass 2b: per-cd issue/hold buckets -> offensive rows (icons + chip per finding). */
export function buildOffensiveRows(
  byName: Record<string, FindingBucket>, cdSpellIds: Record<string, number>, abilities: AbilityIcons,
): RotationFindingRow[] {
  const offensiveRows: RotationFindingRow[] = [];
  for (const [name, bucket] of Object.entries(byName)) {
    if (!bucket.issues.length && !bucket.holds.length) continue;
    const { spellId, icon, rowName } = resolveCd(name, cdSpellIds, abilities);
    for (const finding of [...bucket.issues, ...bucket.holds]) {
      offensiveRows.push({
        severity: finding.severity === 'critical' ? 'critical' : 'warning',
        name: rowName,
        spellId,
        icon,
        timestampMs: finding.timestamp_ms ?? null,
        chip: CAT_LABEL[finding.category],
        measured: finding.measured ?? { value: '-' },
        fix: finding.details?.remedy,
      });
    }
  }
  return offensiveRows;
}

/** Pass 2c: cooldowns that produced a success and no issues -> on-plan chips. */
export function buildOnPlanChips(
  partition: PartitionedFindings, cdSpellIds: Record<string, number>, abilities: AbilityIcons,
): RotationOnPlanChip[] {
  const { byName, successNames } = partition;
  const onPlan: RotationOnPlanChip[] = [];
  for (const name of successNames) {
    if (!byName[name] || (!byName[name].issues.length && !byName[name].holds.length)) {
      const { spellId, icon, rowName } = resolveCd(name, cdSpellIds, abilities);
      onPlan.push({ name: rowName, spellId, icon });
    }
  }
  return onPlan;
}

/** Split findings into rotation-rule rows, per-cd issue rows, and on-plan chips. */
export function bucketRotationFindings(
  findings: AnalysisFinding[], cdSpellIds: Record<string, number>, abilities: AbilityIcons,
): { ruleRows: RotationFindingRow[]; offensiveRows: RotationFindingRow[]; onPlan: RotationOnPlanChip[] } {
  const partition = partitionRotationFindings(findings);
  return {
    ruleRows: buildRuleRows(partition.ruleFindings),
    offensiveRows: buildOffensiveRows(partition.byName, cdSpellIds, abilities),
    onPlan: buildOnPlanChips(partition, cdSpellIds, abilities),
  };
}

/* ----------------------------- pre-fight cooldown plan ----------------------------- */

/** Bench-only cooldown game plan rows, ordered by opener priority. */
export function buildCdPlan(
  cooldowns: RulebookCooldown[], benchmarks: Record<string, PerCdBenchmark>, abilities: AbilityIcons,
): CdPlanRow[] {
  const ordered = [...cooldowns].sort((a, b) => {
    const pa = a.opener_priority ?? 99;
    const pb = b.opener_priority ?? 99;
    return pa !== pb ? pa - pb : a.name.localeCompare(b.name);
  });
  return ordered.map(cd => {
    const cdBench = benchmarks[cd.name];
    const holds = cdBench?.majority_hold && cdBench.hold_targets
      ? Object.entries(cdBench.hold_targets)
          .sort((a, b) => Number(a[0]) - Number(b[0]))
          .map(([idx, target]) => ({ castIndex: Number(idx), targetS: target.target_s }))
      : [];
    return {
      name: cd.name,
      spellId: cd.spell_id ?? null,
      icon: abilities[cd.spell_id].icon,
      firstCastS: cdBench?.avg_first_cast_s ?? null,
      uses: cdBench?.avg_uses ?? null,
      usesPerMin: cdBench?.uses_per_min.avg ?? null,
      bloodlust: (cdBench?.bl_pct ?? 0) >= BL_CONSENSUS_PCT,
      bloodlustPct: (cdBench?.bl_pct ?? 0) >= BL_CONSENSUS_PCT ? cdBench!.bl_pct : null,
      holds,
      rule: cd.usage_rule ?? null,
    };
  });
}

/* ----------------------------- feature service ---------------------------- */

@Injectable({ providedIn: 'root' })
export class RotationFeatureService {
  private readonly source = inject(ROTATION_DATA_SOURCE);
  private readonly wclApi = inject(WclApiService);

  /**
   * Post-raid: fetch the player's own log (report master abilities for icons +
   * Casts/Buffs), read the prepared rotation bench, and produce the offensive
   * findings. Returns an empty view when bench is absent.
   */
  async loadPlayerView(
    spec: string, encounterId: number, reportCode: string, fightId: number, playerId: number,
  ): Promise<RotationPlayerView> {
    const empty: RotationPlayerView = { ruleRows: [], ruleOnPlan: [], offensiveRows: [], onPlan: [] };
    const bench = await this.source.getRotationBench(spec, encounterId);
    if (!bench) return empty;

    try {
      const report = await this.wclApi.getReport(reportCode);
      const fight = report.fights.find(entry => entry.id === fightId);
      if (!fight) return empty;

      const [casts, buffs] = await Promise.all([
        this.wclApi.getAllEvents(reportCode, fightId, 'Casts', fight.startTime, fight.endTime, playerId),
        this.wclApi.getAllEvents(reportCode, fightId, 'Buffs', fight.startTime, fight.endTime, playerId),
      ]);

      const findings = analyzeRotationFindings({
        fStart: fight.startTime, fEnd: fight.endTime, castEvents: casts, buffEvents: buffs,
        cooldowns: bench.major_cooldowns, rules: bench.rules, bench,
      });
      const { ruleRows, offensiveRows, onPlan } = bucketRotationFindings(findings, bench.cd_spell_ids, bench.ability_icons);
      const ruleOnPlan = rulesFollowed(bench.rules, casts, fight.startTime);
      return { ruleRows, ruleOnPlan, offensiveRows, onPlan };
    } catch (err) {
      logWarn(`RotationFeatureService.loadPlayerView ${reportCode}:${fightId}`, err);
      return empty;
    }
  }

  /** Pre-fight: bench-only cooldown plan rows (icons baked onto each row). */
  async loadPlanView(spec: string, encounterId: number): Promise<CdPlanRow[]> {
    const bench = await this.source.getRotationBench(spec, encounterId);
    if (!bench) return [];
    return buildCdPlan(bench.major_cooldowns, bench.per_cd_benchmarks, bench.ability_icons);
  }
}
