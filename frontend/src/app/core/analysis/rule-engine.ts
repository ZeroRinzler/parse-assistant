/**
 * Deterministic rulebook condition engine.
 *
 * Evaluates the machine-readable `condition` on each rulebook rule against the
 * player's cast stream. Two kinds are supported:
 *
 * - `cast_without_prior` - a spell cast without a required companion within a
 *   time window (with an optional context-spell exception).
 * - `hold_cooldown_for_anchor` - spell(s) spent inside the hold window before an
 *   anchor spell comes off cooldown.
 *
 * The two branches are exported separately so each rule kind tests in isolation
 * against a pre-built `castTimes` map.
 */
import { AnalysisFinding } from '../models/analysis.models';
import {
  RulebookRule,
  CastWithoutPriorCondition,
  HoldCooldownForAnchorCondition,
} from '../models/rulebook.models';
import { WclEvent } from '../models/wcl.models';
import { Severity } from './findings';
import { fmtClock } from './format';

/** Map of spell id -> sorted-by-insertion cast times (seconds, fight-relative). */
export type CastTimes = Record<number, number[]>;

/** Build the `spell id -> cast times (s)` index the condition evaluators consume. */
export function buildCastTimes(casts: WclEvent[], fStart: number): CastTimes {
  const castTimes: CastTimes = {};
  for (const c of casts) {
    if (c.type === 'cast' && c.abilityGameID) {
      (castTimes[c.abilityGameID] ??= []).push((c.timestamp - fStart) / 1000);
    }
  }
  return castTimes;
}

/** Evaluate one `cast_without_prior` condition. Returns a finding or null. */
export function evaluateCastWithoutPrior(
  cond: CastWithoutPriorCondition,
  castTimes: CastTimes,
  severity: Severity,
  remedy?: string,
): AnalysisFinding | null {
  const win = cond.window_s ?? 5;
  const exc = cond.exception;
  const primary = [...(castTimes[cond.spell_id] ?? [])].sort((a, b) => a - b);
  const required = castTimes[cond.required_spell_id] ?? [];
  const violations: number[] = [];
  for (const t of primary) {
    if (required.some((rt) => Math.abs(t - rt) <= win)) continue;
    if (exc) {
      const ctx = castTimes[exc.context_spell_id] ?? [];
      const cw = exc.context_window_s ?? 20;
      if (exc.position === 'before' ? ctx.some((ct) => t - ct >= 0 && t - ct <= cw) : ctx.some((ct) => ct - t >= 0 && ct - t <= cw)) continue;
    }
    violations.push(t);
  }
  if (!violations.length) return null;
  return {
    severity,
    category: 'rule_violation',
    timestamp_ms: Math.round(violations[0] * 1000),
    message: `${cond.spell_name} without ${cond.required_spell_name}: ${violations.length} of ${primary.length} cast(s).`,
    details: remedy ? { remedy } : undefined,
  };
}

/** Evaluate one `hold_cooldown_for_anchor` condition. Returns a finding or null. */
export function evaluateHoldForAnchor(
  cond: HoldCooldownForAnchorCondition,
  castTimes: CastTimes,
  severity: Severity,
  remedy?: string,
): AnalysisFinding | null {
  const hw = cond.hold_window_s ?? 15;
  const anchorTimes = [...(castTimes[cond.anchor_spell_id] ?? [])].sort((a, b) => a - b);
  const violations: [string, string, string][] = [];
  let firstT: number | null = null;
  for (const at of anchorTimes.slice(1)) {
    for (let i = 0; i < cond.spell_ids.length; i++) {
      for (const ct of castTimes[cond.spell_ids[i]] ?? []) {
        if (ct >= at - hw && ct < at) {
          violations.push([cond.spell_names?.[i] ?? String(cond.spell_ids[i]), fmtClock(ct), fmtClock(at)]);
          firstT ??= ct;
        }
      }
    }
  }
  if (!violations.length) return null;
  return {
    severity,
    category: 'rule_violation',
    timestamp_ms: firstT != null ? Math.round(firstT * 1000) : undefined,
    message: `${[...new Set(violations.map((v) => v[0]))].join('/')} used in the ${hw}s hold window before ${cond.anchor_spell_name}: ${violations.length} charge(s).`,
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
    const finding =
      cond.kind === 'cast_without_prior'
        ? evaluateCastWithoutPrior(cond, castTimes, severity, rule.action)
        : cond.kind === 'hold_cooldown_for_anchor'
          ? evaluateHoldForAnchor(cond, castTimes, severity, rule.action)
          : null;
    if (finding) findings.push(finding);
  }
  return findings;
}
