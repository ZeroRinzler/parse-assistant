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
import { Result, LoadError, ok, permanent } from '../../../core/result';
import { toLoadError } from '../../../core/http-load-error';
import {
  isOutlierAbove, isOutlierBeyond, isOutlierBelow, castEfficiencyPct,
  closestToZero, benchExpectedUses, fmtClock, sortBySeverity,
} from '../../../shared/analysis/analysis-math';
import { ROTATION_DATA_SOURCE, RotationBench } from './rotation-data-source';

export type Severity = AnalysisFinding['severity'];

export type AbilityIcons = Record<number, { icon: string; name: string }>;

export interface RotationFindingRow {
  severity: 'critical' | 'warning';
  /** Empty for rule rows, which render `what` instead. */
  name: string;
  spellId?: number | null;
  icon: string;
  timestampMs?: number | null;
  chip?: string;
  what?: string;
  measured: { value: string; unit?: string };
  fix?: string;
}

export interface RotationOnPlanChip {
  name: string;
  spellId: number | null;
  icon: string;
}

export interface CdPlanRow {
  name: string;
  spellId: number | null;
  icon: string;
  firstCastS: number | null;
  uses: number | null;
  usesPerMin: number | null;
  bloodlust: boolean;
  bloodlustPct: number | null;
  holds: { castIndex: number; targetS: number }[];
  rule: string | null;
}

/** An `ok` result implies the top-parse bench exists. */
export interface RotationPlayerView {
  ruleRows: RotationFindingRow[];
  ruleOnPlan: string[];
  offensiveRows: RotationFindingRow[];
  onPlan: RotationOnPlanChip[];
}

const BLOODLUST_IDS = new Set([2825, 32182, 80353, 90355, 264667, 390386]);
const BLOODLUST_DURATION_S = 40;
// A cast from BL_WINDOW_LEAD_S before BL through BL_WINDOW_TRAIL_S after it expires counts as aligned.
const BL_WINDOW_LEAD_S = 30;
const BL_WINDOW_TRAIL_S = 15;
/** A cooldown counts as Bloodlust-aligned when at least this share (%) of top parses align it. */
const BL_CONSENSUS_PCT = 50;

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

export function ruleLabel(cond: RuleCondition, description?: string): string {
  if (description) return description;
  return cond.kind === 'cast_without_prior'
    ? `${cond.spell_name} with ${cond.required_spell_name}`
    : `${cond.spell_names.join('/')} held for ${cond.anchor_spell_name}`;
}

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

/** A cooldown's lost/unused + first-cast checks run only when at least this share of top parses used it. */
const MIN_USE_SHARE_FRAC = 0.5;

function usedShare(bench: PerCdBenchmark): number {
  return bench.used_sample_count / bench.sample_count;
}

export interface RotationScanInput {
  fStart: number;
  fEnd: number;
  castEvents: WclEvent[];
  buffEvents: WclEvent[];
  cooldowns: RulebookCooldown[];
  rules: RulebookRule[];
  bench: RotationBench;
}

interface CooldownScan { issues: AnalysisFinding[]; holds: AnalysisFinding[]; blAligned: boolean; }

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

export function checkHoldSuggestions(cdName: string, castTimesMs: number[], cdBench: PerCdBenchmark): AnalysisFinding[] {
  const findings: AnalysisFinding[] = [];
  if (!castTimesMs.length) return findings;
  const times = castTimesMs.map(timeMs => timeMs / 1000);
  for (const [idxStr, target] of Object.entries(cdBench.hold_targets)) {
    const index = parseInt(idxStr, 10) - 1;
    // Need a prior cast to measure a gap; index 0 has none.
    if (index < 1 || index >= times.length) continue;
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
  const topE = bench.top_avg_efficiency;
  const topSD = bench.top_efficiency_stddev;
  const effPct = castEfficiencyPct(totalDtS, fightDurS);
  // Flag only more than 1 sigma below the top-parse efficiency, so beating the top parses never
  // trips a warning. Always a warning, never critical.
  const WARN_SIGMAS_BELOW = 1;
  if (!isOutlierBelow(effPct, topE, topSD, WARN_SIGMAS_BELOW)) return null;
  return {
    severity: 'warning', category: 'cast_efficiency',
    label: 'Low cast efficiency',
    measured: { value: `${effPct.toFixed(1)}%`, unit: `top ${topE.toFixed(0)}%` },
    message: `${effPct.toFixed(1)}% cast efficiency, ${totalDtS.toFixed(1)}s idle. Top: ${topE.toFixed(0)}%.`,
    details: { remedy: `Fill ${totalDtS.toFixed(1)}s of gaps. Top: ${topE.toFixed(0)}%.` } };
}

/** `castTimesMs` are fight-relative (ms, ascending). Null when the cooldown is talent-gated and unused. */
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
  // Judge lost/unused casts and a late opener only when a MAJORITY of top parses used this cooldown:
  // a situational cd most parses skip has a noisy expected count and a meaningless avg_first_cast_s,
  // so flagging it would punish the player for correctly matching the parses.
  if (usedShare(cdBench) >= MIN_USE_SHARE_FRAC) {
    const lost = checkLostUses(cdName, actual, expected, floor, fightDurS);
    if (lost) issues.push(lost);
    const lateOpener = checkFirstCastDelay(cdName, castTimesMs, cdBench);
    if (lateOpener) issues.push(lateOpener);
  }
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

const CAT_LABEL: Record<string, string> = {
  lost_cooldown: 'lost cast',
  cooldown_delay: 'held',
  cooldown_alignment: 'BL miss',
  cast_efficiency: 'downtime',
  hold_suggestion: 'hold',
};

interface FindingBucket { issues: AnalysisFinding[]; holds: AnalysisFinding[]; }

interface ResolvedCd { spellId: number | null; icon: string; rowName: string }

function resolveCd(name: string, cdSpellIds: Record<string, number>, abilities: AbilityIcons): ResolvedCd {
  const spellId = cdSpellIds[name] ?? null;
  return spellId != null
    ? { spellId, icon: abilities[spellId].icon, rowName: abilities[spellId].name }
    : { spellId: null, icon: '', rowName: name };
}

interface PartitionedFindings {
  ruleFindings: AnalysisFinding[];
  byName: Record<string, FindingBucket>;
  successNames: Set<string>;
}

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

@Injectable({ providedIn: 'root' })
export class RotationFeatureService {
  private readonly source = inject(ROTATION_DATA_SOURCE);
  private readonly wclApi = inject(WclApiService);

  async loadPlayerView(
    spec: string, encounterId: number, reportCode: string, fightId: number, playerId: number,
  ): Promise<Result<RotationPlayerView, LoadError>> {
    const bench = await this.source.getBench(spec, encounterId);
    if (!bench.ok) return bench;

    try {
      const report = await this.wclApi.getReport(reportCode);
      const fight = report.fights.find(entry => entry.id === fightId);
      if (!fight) return permanent('Fight not found in this report.', 'rotation.player-view');

      const [casts, buffs] = await Promise.all([
        this.wclApi.getAllEvents(reportCode, fightId, 'Casts', fight.startTime, fight.endTime, playerId),
        this.wclApi.getAllEvents(reportCode, fightId, 'Buffs', fight.startTime, fight.endTime, playerId),
      ]);

      const rules = bench.value.rules;
      const offensiveFindings = analyzeRotationFindings({
        fStart: fight.startTime, fEnd: fight.endTime, castEvents: casts, buffEvents: buffs,
        cooldowns: bench.value.major_cooldowns, rules: [], bench: bench.value,
      });
      const ruleFindings = evaluateRules(rules, casts, fight.startTime);
      const findings = [...offensiveFindings, ...ruleFindings];
      sortBySeverity(findings);
      const { ruleRows, offensiveRows, onPlan } =
        bucketRotationFindings(findings, bench.value.cd_spell_ids, bench.value.ability_icons);
      const ruleOnPlan = rulesFollowed(rules, casts, fight.startTime);
      return ok({ ruleRows, ruleOnPlan, offensiveRows, onPlan });
    } catch (cause) {
      logWarn(`RotationFeatureService.loadPlayerView ${reportCode}:${fightId}`, cause);
      return toLoadError(cause, 'rotation.player-view');
    }
  }

  async loadPlanView(spec: string, encounterId: number): Promise<{ available: boolean; rows: CdPlanRow[] }> {
    const bench = await this.source.getBench(spec, encounterId);
    if (!bench.ok) return { available: false, rows: [] };
    return { available: true, rows: buildCdPlan(bench.value.major_cooldowns, bench.value.per_cd_benchmarks, bench.value.ability_icons) };
  }
}
