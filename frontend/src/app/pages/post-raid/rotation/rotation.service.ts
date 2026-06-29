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
import { PerCdBenchmark, UsesPerMin } from '../../../core/models/encounter.models';
import {
  RulebookCooldown, RulebookRule, RuleCondition,
  CastWithoutPriorCondition, HoldCooldownForAnchorCondition,
} from '../../../core/models/rulebook.models';
import { WclEvent } from '../../../core/models/wcl.models';
import { logWarn } from '../../../core/log';
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

/* ----------------------------- statistical predicates ----------------------------- */

/** True when `value` sits more than `sigmas` stddev ABOVE the mean (strict). */
export function isOutlierAbove(value: number, mean: number, stddev: number, sigmas = 2): boolean {
  return value > mean + sigmas * stddev;
}
/** True when `|value - mean|` exceeds `sigmas` stddev (two-tailed, strict). */
export function isOutlierBeyond(value: number, mean: number, stddev: number, sigmas = 2): boolean {
  return Math.abs(value - mean) > sigmas * stddev;
}
/** True when `value` is more than one stddev BELOW the mean (the critical band). */
export function isCriticallyBelow(value: number, mean: number, stddev: number): boolean {
  return value - mean < -stddev;
}
/** Cast efficiency percentage given total downtime in gaps (clamped to >= 0). */
export function castEfficiencyPct(totalDowntimeS: number, fightDurS: number): number {
  return Math.max(0, (1 - totalDowntimeS / fightDurS) * 100);
}
/** The value closest to zero (smallest absolute value) - the primary BL offset. */
export function closestToZero(values: number[]): number {
  return values.reduce((best, value) => (Math.abs(value) < Math.abs(best) ? value : best));
}
/** Data-driven expected + floor uses for a fight from the top-parse uses/min. */
export function benchExpectedUses(fightDurS: number, upm: UsesPerMin): { expected: number; floor: number } {
  const fightMin = fightDurS / 60;
  const expected = Math.round(upm.avg * fightMin);
  const floor = Math.max(0, Math.round(expected - upm.stddev * fightMin));
  return { expected, floor };
}

/** Bloodlust ids + window grace (mirrors the analysis format module). */
const BLOODLUST_IDS = new Set([2825, 32182, 80353, 90355, 264667, 390386]);
const BLOODLUST_DURATION_S = 40;

/** Format seconds as `mm:ss` (zero-padded). */
export function fmtClock(seconds: number): string {
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}

const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, warning: 1, info: 2, hold_suggestion: 2, success: 3 };
/** Sort findings in place: critical first, success last (stable for equal ranks). */
export function sortBySeverity(findings: AnalysisFinding[]): void {
  findings.sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 4) - (SEVERITY_ORDER[b.severity] ?? 4));
}

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

/** Produce the offensive `AnalysisFinding[]` (ported from cooldown-analysis). */
export function analyzeRotationFindings(
  fStart: number, fEnd: number, castEvents: WclEvent[], buffEvents: WclEvent[],
  cooldowns: RulebookCooldown[], rules: RulebookRule[], bench: RotationBench,
): AnalysisFinding[] {
  const fightDurS = (fEnd - fStart) / 1000;
  const rel = (timestamp: number): number => timestamp - fStart;
  const casts = castEvents
    .filter(event => event.type === 'cast' && event.timestamp >= fStart && event.timestamp <= fEnd)
    .sort((a, b) => a.timestamp - b.timestamp);

  const findings: AnalysisFinding[] = [];

  let blTimeS: number | null = null;
  for (const event of buffEvents) {
    if (event.type === 'applybuff' && BLOODLUST_IDS.has(event.abilityGameID) && event.timestamp >= fStart && event.timestamp <= fEnd) {
      blTimeS = rel(event.timestamp) / 1000;
      break;
    }
  }

  const downtimeThreshMs = bench.downtime_threshold_ms;
  const perCdBench = bench.per_cd_benchmarks ?? {};

  for (const cd of cooldowns) {
    const { spell_id: sid, name: cdName } = cd;
    const wantsBL = cd.align_with_bloodlust !== false;
    const cdCasts = casts.filter(cast => cast.abilityGameID === sid);
    const actual = cdCasts.length;
    const cdIssues: AnalysisFinding[] = [];
    const cdSugg: AnalysisFinding[] = [];
    const cdBench = perCdBench[cdName];

    if (cd.talent_gated && actual === 0) continue;

    if (!cdBench) {
      if (actual > 0) findings.push({ severity: 'success', category: 'cooldown_usage', cd_name: cdName,
        message: `${cdName}: ${actual} casts (no bench data).` });
      continue;
    }

    const { expected, floor } = benchExpectedUses(fightDurS, cdBench.uses_per_min);

    if (actual === 0 && expected >= 1) {
      cdIssues.push({ severity: 'critical', category: 'lost_cooldown', cd_name: cdName,
        measured: { value: `0 / ${expected}`, unit: 'cast(s)' },
        message: `${cdName} unused. Expected ${expected} on a ${fmtClock(fightDurS)} fight.`,
        details: { remedy: `Use ${cdName} ${expected}x this fight.` } });
    } else if (actual > 0 && actual < floor) {
      cdIssues.push({ severity: 'critical', category: 'lost_cooldown', cd_name: cdName,
        measured: { value: `${actual} / ${expected}`, unit: 'cast(s)' },
        message: `${cdName}: ${actual} casts, expected ${expected}. ${floor - actual} lost.`,
        details: { remedy: `Press ${cdName} ${floor - actual}x more - sooner off cooldown.` } });
    }

    if (cdCasts.length) {
      const firstS = rel(cdCasts[0].timestamp) / 1000;
      if (isOutlierAbove(firstS, cdBench.avg_first_cast_s, cdBench.stddev_first_cast_s)) cdIssues.push({
        severity: 'warning', category: 'cooldown_delay', cd_name: cdName,
        timestamp_ms: rel(cdCasts[0].timestamp),
        measured: { value: `+${(firstS - cdBench.avg_first_cast_s).toFixed(0)}s`, unit: `top ${fmtClock(cdBench.avg_first_cast_s)}` },
        message: `${cdName} opened at ${fmtClock(firstS)}, ${(firstS - cdBench.avg_first_cast_s).toFixed(0)}s late. Top: ${fmtClock(cdBench.avg_first_cast_s)}.`,
        details: { remedy: `Open with ${cdName} earlier.` } });
    }

    let blAligned = false;
    if (blTimeS !== null && cdCasts.length) {
      const blWin = cdCasts.filter(cast => {
        const time = rel(cast.timestamp) / 1000;
        return time >= blTimeS! - 30 && time <= blTimeS! + BLOODLUST_DURATION_S + 15;
      });
      blAligned = blWin.length > 0;
      if (!blAligned && wantsBL) {
        cdIssues.push({ severity: 'critical', category: 'cooldown_alignment', cd_name: cdName,
          timestamp_ms: rel(cdCasts[0].timestamp),
          measured: { value: 'missed', unit: 'BL' },
          message: `${cdName} missed Bloodlust (BL at ${fmtClock(blTimeS)}, first cast at ${fmtClock(rel(cdCasts[0].timestamp) / 1000)}).`,
          details: { remedy: `Align ${cdName} with Bloodlust.` } });
      } else if (blAligned && cdBench.avg_bl_offset_s != null && cdBench.stddev_bl_offset_s != null) {
        const offsets = blWin.map(cast => rel(cast.timestamp) / 1000 - blTimeS!);
        const playerOffset = closestToZero(offsets);
        if (isOutlierBeyond(playerOffset, cdBench.avg_bl_offset_s, cdBench.stddev_bl_offset_s)) {
          const dir = playerOffset > cdBench.avg_bl_offset_s ? 'late' : 'early';
          cdIssues.push({ severity: 'warning', category: 'cooldown_alignment', cd_name: cdName,
            timestamp_ms: rel(blWin[0].timestamp),
            measured: { value: dir, unit: 'in BL' },
            message: `${cdName} ${dir} in the Bloodlust window.`,
            details: { remedy: `Tighten ${cdName} to the Bloodlust window.` } });
        }
      }
    }

    for (let i = 1; i < cdCasts.length; i++) {
      const gap = (rel(cdCasts[i].timestamp) - rel(cdCasts[i - 1].timestamp)) / 1000;
      if (cdBench.avg_gap_s != null && cdBench.stddev_gap_s != null && isOutlierAbove(gap, cdBench.avg_gap_s, cdBench.stddev_gap_s)) {
        cdIssues.push({ severity: 'warning', category: 'cooldown_delay', cd_name: cdName,
          timestamp_ms: rel(cdCasts[i].timestamp),
          measured: { value: `${gap.toFixed(0)}s`, unit: `avg ${cdBench.avg_gap_s.toFixed(0)}s` },
          message: `${cdName} at ${fmtClock(rel(cdCasts[i].timestamp) / 1000)}: ${gap.toFixed(0)}s gap, top ${cdBench.avg_gap_s.toFixed(0)}s.`,
          details: { remedy: `Press ${cdName} sooner - top gap ${cdBench.avg_gap_s.toFixed(0)}s.` } });
      }
    }

    if (cdCasts.length) {
      const times = cdCasts.map(cast => rel(cast.timestamp) / 1000);
      for (const [idxStr, target] of Object.entries(cdBench.hold_targets)) {
        const index = parseInt(idxStr, 10) - 1;
        if (index >= times.length) continue;
        const playerT = times[index];
        if (playerT < target.target_s - target.stddev_s) cdSugg.push({ severity: 'info', category: 'hold_suggestion',
          timestamp_ms: rel(cdCasts[index].timestamp),
          measured: { value: fmtClock(playerT), unit: `top ~${fmtClock(target.target_s)}` },
          message: `${cdName} cast ${idxStr} at ${fmtClock(playerT)}. ${target.count}/${target.total_samples} top parses hold to ${fmtClock(target.target_s)}.`,
          details: { remedy: `Hold ${cdName} to ${fmtClock(target.target_s)}.`, cd_name: cdName } });
      }
    }

    if (cdIssues.length) findings.push(...cdIssues);
    else if (actual > 0) findings.push({ severity: 'success', category: 'cooldown_usage', cd_name: cdName,
      message: `${cdName} - ${actual}/${expected} casts${blAligned && wantsBL ? ', BL-aligned' : ''}.` });
    if (actual > 0) findings.push(...cdSugg);
  }

  if (rules.length) findings.push(...evaluateRules(rules, casts, fStart));

  if (casts.length >= 2 && downtimeThreshMs != null) {
    const gaps: number[] = [];
    for (let i = 1; i < casts.length; i++) {
      const gapMs = rel(casts[i].timestamp) - rel(casts[i - 1].timestamp);
      if (gapMs > downtimeThreshMs) gaps.push(gapMs);
    }
    const totalDtS = gaps.reduce((sum, gap) => sum + gap, 0) / 1000;
    if (totalDtS > 5) {
      const topE = bench.top_avg_efficiency;
      const topSD = bench.top_efficiency_stddev;
      const effPct = castEfficiencyPct(totalDtS, fightDurS);
      const severity: Severity = isCriticallyBelow(effPct, topE, topSD) ? 'critical' : 'warning';
      findings.push({ severity, category: 'cast_efficiency',
        label: 'Low cast efficiency',
        measured: { value: `${effPct.toFixed(1)}%`, unit: `top ${topE.toFixed(0)}%` },
        message: `${effPct.toFixed(1)}% cast efficiency, ${totalDtS.toFixed(1)}s idle. Top: ${topE.toFixed(0)}%.`,
        details: { remedy: `Fill ${totalDtS.toFixed(1)}s of gaps. Top: ${topE.toFixed(0)}%.` } });
    }
  }

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

/** Split findings into rotation-rule rows, per-cd issue rows, and on-plan chips. */
export function bucketRotationFindings(
  findings: AnalysisFinding[], cdSpellIds: Record<string, number>, abilities: AbilityIcons,
): { ruleRows: RotationFindingRow[]; offensiveRows: RotationFindingRow[]; onPlan: RotationOnPlanChip[] } {
  const ruleFindings: AnalysisFinding[] = [];
  const byName: Record<string, FindingBucket> = {};
  const successNames = new Set<string>();

  // Resolve a cooldown name to its spell id + baked icon + display name. A name with
  // no spell id renders as plain text (empty icon, the name itself).
  const resolve = (name: string): { spellId: number | null; icon: string; rowName: string } => {
    const spellId = cdSpellIds[name] ?? null;
    return spellId != null
      ? { spellId, icon: abilities[spellId].icon, rowName: abilities[spellId].name }
      : { spellId: null, icon: '', rowName: name };
  };

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

  const ruleRows: RotationFindingRow[] = ruleFindings.map(finding => ({
    severity: finding.severity === 'critical' ? 'critical' : 'warning',
    name: '',
    icon: '',
    what: finding.label,
    measured: finding.measured ?? { value: '-' },
    fix: finding.details?.remedy,
  }));

  const offensiveRows: RotationFindingRow[] = [];
  for (const [name, bucket] of Object.entries(byName)) {
    if (!bucket.issues.length && !bucket.holds.length) continue;
    const { spellId, icon, rowName } = resolve(name);
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

  // On-plan: a cooldown that produced a success and no issues.
  const onPlan: RotationOnPlanChip[] = [];
  for (const name of successNames) {
    if (!byName[name] || (!byName[name].issues.length && !byName[name].holds.length)) {
      const { spellId, icon, rowName } = resolve(name);
      onPlan.push({ name: rowName, spellId, icon });
    }
  }

  return { ruleRows, offensiveRows, onPlan };
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
      bloodlust: !!cd.align_with_bloodlust,
      bloodlustPct: cd.align_with_bloodlust && cdBench && cdBench.bl_pct >= 40 ? cdBench.bl_pct : null,
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

      const findings = analyzeRotationFindings(
        fight.startTime, fight.endTime, casts, buffs, bench.major_cooldowns, bench.rules, bench,
      );
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
