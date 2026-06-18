/**
 * Defensive analysis. Mirrors the cooldown path but is buff-window-centric:
 * each defensive "use" is the apply->remove span of its buff (falling back to
 * cast + duration when buff events are absent), and findings reuse the same
 * bench-stats atoms as the offensive cooldowns.
 */
import { AnalysisFinding, PlayerDefensive } from '../models/analysis.models';
import { PerDefensiveBenchmark } from '../models/encounter.models';
import { RulebookDefensive } from '../models/rulebook.models';
import { WclEvent } from '../models/wcl.models';
import { sortBySeverity } from './findings';
import { fmtClock } from './format';
import { isOutlierAbove, expectedUses } from './bench-stats';

/** Build per-defensive usage windows (buff-window-centric, cast+duration fallback). */
export function analyzeDefensives(
  defs: RulebookDefensive[],
  castEvents: WclEvent[],
  buffEvents: WclEvent[],
  dtEvents: WclEvent[],
  fStart: number,
  fEnd: number,
): PlayerDefensive[] {
  if (!defs.length) return [];
  const rel = (ts: number) => ts - fStart;
  // Pre-filter damage-taken events once instead of re-scanning per window.
  const dmgTaken = dtEvents.filter((e) => e.type === 'damage');
  const buffWin: Record<number, [number, number | null][]> = {};
  for (const e of buffEvents) {
    const sid = e.abilityGameID;
    const tS = rel(e.timestamp) / 1000;
    if (e.type === 'applybuff') (buffWin[sid] ??= []).push([tS, null]);
    else if (e.type === 'removebuff') {
      for (let i = (buffWin[sid]?.length ?? 0) - 1; i >= 0; i--)
        if (buffWin[sid][i][1] === null) { buffWin[sid][i][1] = tS; break; }
    }
  }
  const dmgInWindow = (wS: number, wE: number): number =>
    dmgTaken.reduce((s, e) => {
      const t = rel(e.timestamp) / 1000;
      return t >= wS && t <= wE ? s + (e.amount || 0) + (e.absorbed || 0) : s;
    }, 0);
  return defs.map((def) => {
    const { spell_id: sid, duration: dur = 0 } = def;
    let windows = (buffWin[sid] || []).map(([wS, wE]) => {
      const end = wE ?? wS + (dur || 5);
      return { start_s: Math.round(wS * 10) / 10, end_s: Math.round(end * 10) / 10, dmg_during: Math.round(dmgInWindow(wS, end)) };
    });
    if (!windows.length) {
      windows = castEvents
        .filter((c) => c.type === 'cast' && c.abilityGameID === sid && c.timestamp >= fStart && c.timestamp <= fEnd)
        .map((c) => {
          const tS = rel(c.timestamp) / 1000;
          const wE = tS + (dur || 5);
          return { start_s: Math.round(tS * 10) / 10, end_s: Math.round(wE * 10) / 10, dmg_during: Math.round(dmgInWindow(tS, wE)) };
        });
    }
    const cast_times_s = windows.map((w) => w.start_s).sort((a, b) => a - b);
    return { name: def.name, spell_id: sid, cooldown: def.cooldown, uses: windows.length, cast_times_s, windows };
  });
}

/** Lost / delayed / hold-suggestion findings per defensive, vs top-parse benchmarks. */
export function analyzeDefensiveFindings(
  playerDefensives: PlayerDefensive[],
  perDefBench: Record<string, PerDefensiveBenchmark>,
  fightDurS: number,
): AnalysisFinding[] {
  const findings: AnalysisFinding[] = [];

  for (const def of playerDefensives) {
    const { name, cooldown: cooldownS, uses, cast_times_s } = def;
    const expected = expectedUses(fightDurS, cooldownS);
    const b = perDefBench[name];
    const issues: AnalysisFinding[] = [];
    const suggestions: AnalysisFinding[] = [];

    if (uses === 0) {
      issues.push({ severity: 'critical', category: 'lost_cooldown', cd_name: name, timestamp_ms: undefined,
        message: `${name} was never used. Expected ~${expected} use(s) in a ${fmtClock(fightDurS)} fight.` });
    } else if (uses < expected) {
      issues.push({ severity: 'critical', category: 'lost_cooldown', cd_name: name, timestamp_ms: undefined,
        message: `${name} - ${uses} of ${expected} expected uses. Lost ${expected - uses} use(s).` });
    }

    if (cast_times_s?.length) {
      const firstS = cast_times_s[0];
      if (b?.avg_first_cast_s != null && b.stddev_first_cast_s != null) {
        const sdF = b.stddev_first_cast_s;
        if (isOutlierAbove(firstS, b.avg_first_cast_s, sdF)) {
          issues.push({ severity: 'warning', category: 'cooldown_delay', cd_name: name,
            timestamp_ms: Math.round(firstS * 1000),
            message: `${name} first use at ${fmtClock(firstS)} - ${(firstS - b.avg_first_cast_s).toFixed(0)}s later than top parsers (${fmtClock(b.avg_first_cast_s)} avg).` });
        }
      }

      for (let i = 1; i < cast_times_s.length; i++) {
        const gap = cast_times_s[i] - cast_times_s[i - 1];
        if (b?.avg_gap_s != null && b.stddev_gap_s != null) {
          const sdG = b.stddev_gap_s;
          if (isOutlierAbove(gap, b.avg_gap_s, sdG)) {
            issues.push({ severity: 'warning', category: 'cooldown_delay', cd_name: name,
              timestamp_ms: Math.round(cast_times_s[i] * 1000),
              message: `${name} at ${fmtClock(cast_times_s[i])}: ${gap.toFixed(0)}s gap vs top-parse avg ${b.avg_gap_s.toFixed(0)}s ±${sdG.toFixed(0)}s.` });
          }
        }
      }

      if (b?.hold_targets) {
        for (const [idxStr, target] of Object.entries(b.hold_targets)) {
          const k = parseInt(idxStr, 10) - 1;
          if (k >= cast_times_s.length) continue;
          const playerT = cast_times_s[k];
          const tol = target.stddev_s;
          if (playerT < target.target_s - tol) {
            suggestions.push({ severity: 'info', category: 'hold_suggestion',
              timestamp_ms: Math.round(playerT * 1000),
              message: `${name} use ${idxStr} at ${fmtClock(playerT)} - ${target.count}/${target.total_samples} top parsers hold until ~${fmtClock(target.target_s)}.`,
              details: { remedy: `Consider holding ${name} until ~${fmtClock(target.target_s)}.`, cd_name: name } });
          }
        }
      }
    }

    if (issues.length) findings.push(...issues);
    else if (uses > 0) findings.push({ severity: 'success', category: 'cooldown_usage', cd_name: name,
      message: `${name} - ${uses}/${expected} uses.` });
    if (uses > 0) findings.push(...suggestions);
  }

  sortBySeverity(findings);
  return findings;
}
