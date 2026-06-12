/**
 * Pure, framework-free analysis computation.
 *
 * This module contains the CPU-bound part of the rules engine. It has no
 * Angular dependencies so it can run inside a Web Worker (see
 * `analysis.worker.ts`) and keep the heavy event crunching off the main
 * thread. `AnalysisEngineService` handles the network I/O and delegates the
 * computation here.
 */
import { AnalysisResult, AnalysisFinding, BurstWindow, PlayerBurstWindow, PlayerDefensive } from '../models/analysis.models';
import { EncounterBench, PerDefensiveBenchmark } from '../models/encounter.models';
import { Rulebook, RulebookCooldown, RulebookDefensive, RulebookRule } from '../models/rulebook.models';
import { WclEvent, WclAbility } from '../models/wcl.models';

const BLOODLUST_IDS = new Set([2825, 32182, 80353, 90355, 264667, 390386]);
const BLOODLUST_DURATION_S = 40;

type Severity = AnalysisFinding['severity'];

function _fmt(s: number): string {
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

/** Everything the pure computation needs — all data already fetched on the main thread. */
export interface AnalysisInput {
  playerName: string;
  spec: string;
  fStart: number;
  fEnd: number;
  castEvents: WclEvent[];
  buffEvents: WclEvent[];
  dmgEvents: WclEvent[];
  dtEvents: WclEvent[];
  rulebook: Rulebook | null;
  bench: EncounterBench | null;
  masterAbilities: WclAbility[];
}

/**
 * Run the full client-side analysis. Mirrors the post-fetch portion of the old
 * `AnalysisEngineService.run()`. Returns a plain `AnalysisResult` — safe to
 * `postMessage` back from a worker.
 */
export function computeAnalysis(input: AnalysisInput): AnalysisResult {
  const { playerName, spec, fStart, fEnd, castEvents, buffEvents, dmgEvents, dtEvents, rulebook, bench, masterAbilities } = input;

  const abilityMap: Record<string, { name: string; icon: string }> = {};
  for (const a of (masterAbilities || [])) {
    if (a.gameID) abilityMap[String(a.gameID)] = { name: a.name || '', icon: a.icon || '' };
  }
  // Stored once on the result; the main thread seeds the icon cache from this.
  const ability_icons = Object.fromEntries(
    Object.entries(abilityMap).map(([id, v]) => [id, { icon: v.icon.replace(/\.jpg$/i, ''), name: v.name }])
  );

  const specCds = rulebook?.major_cooldowns ?? null;
  const rules = rulebook?.rules ?? [];
  const defensives = rulebook?.defensives ?? [];

  const result = _analyzeCore(playerName, spec, fStart, fEnd, castEvents, buffEvents, specCds, rules, bench);
  result.spec = spec;
  result.rulebook_source = rulebook ? 'generated' : 'none';
  result.player_fight_duration_s = result.player_fight_duration_s ?? (fEnd - fStart) / 1000;
  result.cd_spell_ids = Object.fromEntries((specCds ?? []).map(cd => [cd.name, cd.spell_id]));
  result.ability_icons = ability_icons;

  if (bench) {
    if (bench.burst_windows?.length) result.burst_windows = bench.burst_windows;
    if (bench.top_defensives_summary?.length) result.top_defensives_summary = bench.top_defensives_summary;
    if (bench.top_dtk_comparison?.length) result.top_dtk_comparison = bench.top_dtk_comparison;
    if (bench.top_dtk_segments?.length) result.top_dtk_segments = bench.top_dtk_segments;
  }

  if (result.burst_windows?.length) {
    result.player_burst_windows = _findPlayerBurstWindows(result.burst_windows, dmgEvents, fStart);
  }
  result.player_defensives = _analyzeDefensives(defensives, castEvents, buffEvents, dtEvents, fStart, fEnd);

  if (defensives.length && result.player_defensives.length) {
    result.defensive_findings = _analyzeDefensiveFindings(
      result.player_defensives,
      bench?.per_defensive_benchmarks ?? {},
      (fEnd - fStart) / 1000,
    );
  }

  const topDefWindows = bench?.defensive_windows;
  if (topDefWindows?.length) {
    result.top_defensive_windows = topDefWindows;
    result.player_defensive_windows = _computePlayerDefensiveWindows(topDefWindows, dtEvents, fStart);
  }

  const dtk = _analyzeDamageTaken(dtEvents, abilityMap, fStart, fEnd);
  result.player_dmg_taken_segment_pcts = dtk.segmentPcts;
  result.player_dmg_taken_by_ability = dtk.top;
  result.player_total_dmg_taken = dtk.total;

  return result;
}

function _analyzeCore(
  playerName: string, spec: string, fStart: number, fEnd: number,
  castEvents: WclEvent[], buffEvents: WclEvent[], specCds: RulebookCooldown[] | null,
  rules: RulebookRule[], bench: EncounterBench | null,
): AnalysisResult {
  const fightDurS = (fEnd - fStart) / 1000;
  const rel = (ts: number) => ts - fStart;
  const casts = castEvents
    .filter(e => e.type === 'cast' && e.timestamp >= fStart && e.timestamp <= fEnd)
    .sort((a, b) => a.timestamp - b.timestamp);

  const findings: AnalysisFinding[] = [];

  let blTimeS: number | null = null;
  for (const e of buffEvents) {
    if (e.type === 'applybuff' && BLOODLUST_IDS.has(e.abilityGameID) && e.timestamp >= fStart && e.timestamp <= fEnd) {
      blTimeS = rel(e.timestamp) / 1000; break;
    }
  }

  const downtimeThreshMs = bench?.downtime_threshold_ms ?? 1500;
  const perCdBench = bench?.per_cd_benchmarks ?? {};

  if (!specCds) {
    findings.push({ severity: 'info', category: 'unsupported_spec', message: `${spec} is not yet in the rulebook. Cast efficiency analysis still applies.` });
  } else {
    for (const cd of specCds) {
      const { spell_id: sid, name: cdName, cooldown: cooldownS } = cd;
      const wantsBL = cd.align_with_bloodlust !== false;
      const cdCasts = casts.filter(c => c.abilityGameID === sid);
      const actual = cdCasts.length;
      const expected = 1 + Math.floor(fightDurS / cooldownS);
      const cdIssues: AnalysisFinding[] = [], cdSugg: AnalysisFinding[] = [];

      if (actual === 0) {
        cdIssues.push({ severity: 'critical', category: 'lost_cooldown', cd_name: cdName, timestamp_ms: undefined,
          message: `${cdName} was never used. In a ${_fmt(fightDurS)} fight with a ${cooldownS}s cooldown you should have ~${expected} cast(s).` });
      } else if (actual < expected) {
        cdIssues.push({ severity: 'critical', category: 'lost_cooldown', cd_name: cdName, timestamp_ms: undefined,
          message: `${cdName} — ${actual} of ${expected} expected casts. Lost ${expected - actual} use(s) in a ${_fmt(fightDurS)} fight.` });
      }

      const b = perCdBench[cdName];
      if (cdCasts.length) {
        const firstS = rel(cdCasts[0].timestamp) / 1000;
        if (b?.avg_first_cast_s != null) {
          const sdF = b.stddev_first_cast_s ?? 10;
          if (firstS > b.avg_first_cast_s + 2 * sdF) cdIssues.push({ severity: 'warning', category: 'cooldown_delay', cd_name: cdName,
            timestamp_ms: rel(cdCasts[0].timestamp),
            message: `${cdName} opener at ${_fmt(firstS)} — ${(firstS - b.avg_first_cast_s).toFixed(0)}s later than top parsers (${_fmt(b.avg_first_cast_s)} avg ±${sdF.toFixed(0)}s).` });
        } else if (firstS > 30) {
          cdIssues.push({ severity: 'warning', category: 'cooldown_delay', cd_name: cdName,
            timestamp_ms: rel(cdCasts[0].timestamp),
            message: `${cdName} first cast at ${_fmt(firstS)} (${firstS.toFixed(0)}s into the fight). Late opener risks losing a full use.` });
        }
      }

      let blAligned = false;
      if (blTimeS !== null && cdCasts.length) {
        const blWin = cdCasts.filter(c => { const t = rel(c.timestamp) / 1000; return t >= blTimeS! - 30 && t <= blTimeS! + BLOODLUST_DURATION_S + 15; });
        blAligned = blWin.length > 0;
        if (!blAligned && wantsBL) {
          cdIssues.push({ severity: 'critical', category: 'cooldown_alignment', cd_name: cdName,
            timestamp_ms: rel(cdCasts[0].timestamp),
            message: `${cdName} missed Bloodlust (BL at ${_fmt(blTimeS)}, first cast at ${_fmt(rel(cdCasts[0].timestamp) / 1000)}).` });
        } else if (blAligned && b?.avg_bl_offset_s != null) {
          const offsets = blWin.map(c => rel(c.timestamp) / 1000 - blTimeS!);
          const po = offsets.reduce((best, x) => Math.abs(x) < Math.abs(best) ? x : best);
          const sd = b.stddev_bl_offset_s ?? 5;
          if (Math.abs(po - b.avg_bl_offset_s) > 2 * sd) {
            const dir = po > b.avg_bl_offset_s ? 'late' : 'early';
            cdIssues.push({ severity: 'warning', category: 'cooldown_alignment', cd_name: cdName,
              timestamp_ms: rel(blWin[0].timestamp),
              message: `${cdName} used ${dir} in the BL window vs top parsers.` });
          }
        }
      }

      for (let i = 1; i < cdCasts.length; i++) {
        const gap = (rel(cdCasts[i].timestamp) - rel(cdCasts[i - 1].timestamp)) / 1000;
        if (b?.avg_gap_s != null) {
          const sdG = b.stddev_gap_s ?? cooldownS * 0.2;
          if (gap > b.avg_gap_s + 2 * sdG) cdIssues.push({ severity: 'warning', category: 'cooldown_delay', cd_name: cdName,
            timestamp_ms: rel(cdCasts[i].timestamp),
            message: `${cdName} at ${_fmt(rel(cdCasts[i].timestamp) / 1000)}: ${gap.toFixed(0)}s gap vs top-parse avg ${b.avg_gap_s.toFixed(0)}s ±${sdG.toFixed(0)}s.` });
        } else if (gap > cooldownS * 1.2) {
          cdIssues.push({ severity: 'warning', category: 'cooldown_delay', cd_name: cdName,
            timestamp_ms: rel(cdCasts[i].timestamp),
            message: `${cdName} held ${(gap - cooldownS).toFixed(0)}s past reset at ${_fmt(rel(cdCasts[i].timestamp) / 1000)}.` });
        }
      }

      if (b?.hold_targets && cdCasts.length) {
        const times = cdCasts.map(c => rel(c.timestamp) / 1000);
        for (const [idxStr, target] of Object.entries(b.hold_targets)) {
          const k = parseInt(idxStr, 10) - 1;
          if (k >= times.length) continue;
          const playerT = times[k], tol = Math.max(target.stddev_s ?? 20, 15);
          if (playerT < target.target_s - tol) cdSugg.push({ severity: 'info', category: 'hold_suggestion',
            timestamp_ms: rel(cdCasts[k].timestamp),
            message: `${cdName} cast ${idxStr} at ${_fmt(playerT)} — ${target.count}/${target.total_samples} top parsers hold until ~${_fmt(target.target_s)}.`,
            details: { remedy: `Consider holding ${cdName} until ~${_fmt(target.target_s)}.`, cd_name: cdName } });
        }
      }

      if (cdIssues.length) findings.push(...cdIssues);
      else if (actual > 0) findings.push({ severity: 'success', category: 'cooldown_usage', cd_name: cdName,
        message: `${cdName} — ${actual}/${expected} casts${blAligned && wantsBL ? ', BL-aligned' : ''}.` });
      if (actual > 0) findings.push(...cdSugg);
    }
  }

  if (rules.length) findings.push(..._evaluateRules(rules, casts, fStart));

  if (casts.length >= 2) {
    const gaps: { start_ms: number; duration_ms: number }[] = [];
    for (let i = 1; i < casts.length; i++) {
      const gMs = rel(casts[i].timestamp) - rel(casts[i - 1].timestamp);
      if (gMs > downtimeThreshMs) gaps.push({ start_ms: rel(casts[i - 1].timestamp), duration_ms: gMs });
    }
    const totalDtS = gaps.reduce((s, g) => s + g.duration_ms, 0) / 1000;
    if (totalDtS > 5) {
      const topE = bench?.top_avg_efficiency ?? null;
      const topSD = bench?.top_efficiency_stddev ?? null;
      const effPct = Math.max(0, (1 - totalDtS / fightDurS) * 100);
      const delta = topE != null ? effPct - topE : null;
      let severity: Severity = 'warning';
      if (delta != null && topSD != null && delta < -topSD) severity = 'critical';
      findings.push({ severity, category: 'cast_efficiency',
        message: `Cast efficiency: ${effPct.toFixed(1)}% (${topE != null ? `top avg ${topE.toFixed(0)}%` : 'no benchmark'}) — ${totalDtS.toFixed(1)}s in gaps.` });
    }
  }

  _sortBySeverity(findings);

  return {
    player: playerName, spec, rulebook_source: 'none',
    findings, cd_spell_ids: {}, ability_icons: {},
    player_fight_duration_s: Math.round(fightDurS * 10) / 10,
  };
}

function _evaluateRules(rules: RulebookRule[], casts: WclEvent[], fStart: number): AnalysisFinding[] {
  const findings: AnalysisFinding[] = [];
  const castTimes: Record<number, number[]> = {};
  for (const c of casts) {
    if (c.type === 'cast' && c.abilityGameID) (castTimes[c.abilityGameID] ??= []).push((c.timestamp - fStart) / 1000);
  }
  for (const rule of rules) {
    const cond = rule.condition;
    if (!cond) continue;
    const severity: Severity = rule.priority === 'critical' ? 'critical' : 'warning';

    if (cond.kind === 'cast_without_prior') {
      const win = cond.window_s ?? 5;
      const exc = cond.exception;
      const primary = [...(castTimes[cond.spell_id] ?? [])].sort((a, b) => a - b);
      const required = castTimes[cond.required_spell_id] ?? [];
      const violations: number[] = [];
      for (const t of primary) {
        if (required.some(rt => Math.abs(t - rt) <= win)) continue;
        if (exc) {
          const ctx = castTimes[exc.context_spell_id] ?? [];
          const cw = exc.context_window_s ?? 20;
          if (exc.position === 'before' ? ctx.some(ct => t - ct >= 0 && t - ct <= cw) : ctx.some(ct => ct - t >= 0 && ct - t <= cw)) continue;
        }
        violations.push(t);
      }
      if (violations.length) findings.push({ severity, category: 'rule_violation',
        timestamp_ms: Math.round(violations[0] * 1000),
        message: `${cond.spell_name} without ${cond.required_spell_name}: ${violations.length} of ${primary.length} cast(s).`,
        details: rule.action ? { remedy: rule.action } : undefined });

    } else if (cond.kind === 'hold_cooldown_for_anchor') {
      const hw = cond.hold_window_s ?? 15;
      const anchorTimes = [...(castTimes[cond.anchor_spell_id] ?? [])].sort((a, b) => a - b);
      const violations: [string, string, string][] = [];
      let firstT: number | null = null;
      for (const at of anchorTimes.slice(1)) {
        for (let i = 0; i < cond.spell_ids.length; i++) {
          for (const ct of (castTimes[cond.spell_ids[i]] ?? [])) {
            if (ct >= at - hw && ct < at) {
              violations.push([cond.spell_names?.[i] ?? String(cond.spell_ids[i]), _fmt(ct), _fmt(at)]);
              firstT ??= ct;
            }
          }
        }
      }
      if (violations.length) findings.push({ severity, category: 'rule_violation',
        timestamp_ms: firstT != null ? Math.round(firstT * 1000) : undefined,
        message: `${[...new Set(violations.map(v => v[0]))].join('/')} used in the ${hw}s hold window before ${cond.anchor_spell_name}: ${violations.length} charge(s).`,
        details: rule.action ? { remedy: rule.action } : undefined });
    }
  }
  return findings;
}

function _findPlayerBurstWindows(
  topBurstWindows: BurstWindow[], dmgEvents: WclEvent[], fStart: number,
): PlayerBurstWindow[] {
  const sorted = dmgEvents
    .filter(e => e.timestamp >= fStart && ((e.amount || 0) + (e.absorbed || 0)) > 0)
    .sort((a, b) => a.timestamp - b.timestamp);
  const totalDmg = sorted.reduce((s, e) => s + (e.amount || 0) + (e.absorbed || 0), 0) || 1;

  return topBurstWindows.map(bw => {
    const winLenS = bw.window_length_s ?? 8;
    const winEvents = sorted.filter(e => {
      const tS = (e.timestamp - fStart) / 1000;
      return tS >= bw.time_s && tS < bw.time_s + winLenS;
    });
    const winTotal = winEvents.reduce((s, e) => s + (e.amount || 0) + (e.absorbed || 0), 0);
    const byAb: Record<number, number> = {};
    for (const e of winEvents) {
      if (e.abilityGameID) byAb[e.abilityGameID] = (byAb[e.abilityGameID] || 0) + (e.amount || 0) + (e.absorbed || 0);
    }
    const ability_breakdown = Object.entries(byAb).sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([sid, dmg]) => ({ spell_id: parseInt(sid, 10), pct: Math.round(dmg / (winTotal || 1) * 1000) / 1000 }));
    return { time_s: bw.time_s, pct_of_total: Math.round(winTotal / totalDmg * 1000) / 1000, ability_breakdown };
  });
}

function _analyzeDefensiveFindings(
  playerDefensives: PlayerDefensive[],
  perDefBench: Record<string, PerDefensiveBenchmark>,
  fightDurS: number,
): AnalysisFinding[] {
  const findings: AnalysisFinding[] = [];

  for (const def of playerDefensives) {
    const { name, cooldown: cooldownS, uses, cast_times_s } = def;
    const expected = 1 + Math.floor(fightDurS / cooldownS);
    const b = perDefBench[name];
    const issues: AnalysisFinding[] = [];
    const suggestions: AnalysisFinding[] = [];

    if (uses === 0) {
      issues.push({ severity: 'critical', category: 'lost_cooldown', cd_name: name, timestamp_ms: undefined,
        message: `${name} was never used. Expected ~${expected} use(s) in a ${_fmt(fightDurS)} fight.` });
    } else if (uses < expected) {
      issues.push({ severity: 'critical', category: 'lost_cooldown', cd_name: name, timestamp_ms: undefined,
        message: `${name} — ${uses} of ${expected} expected uses. Lost ${expected - uses} use(s).` });
    }

    if (cast_times_s?.length) {
      const firstS = cast_times_s[0];
      if (b?.avg_first_cast_s != null) {
        const sdF = b.stddev_first_cast_s ?? 15;
        if (firstS > b.avg_first_cast_s + 2 * sdF) {
          issues.push({ severity: 'warning', category: 'cooldown_delay', cd_name: name,
            timestamp_ms: Math.round(firstS * 1000),
            message: `${name} first use at ${_fmt(firstS)} — ${(firstS - b.avg_first_cast_s).toFixed(0)}s later than top parsers (${_fmt(b.avg_first_cast_s)} avg).` });
        }
      } else if (firstS > 90) {
        issues.push({ severity: 'warning', category: 'cooldown_delay', cd_name: name,
          timestamp_ms: Math.round(firstS * 1000),
          message: `${name} first use at ${_fmt(firstS)} — unusually late.` });
      }

      for (let i = 1; i < cast_times_s.length; i++) {
        const gap = cast_times_s[i] - cast_times_s[i - 1];
        if (b?.avg_gap_s != null) {
          const sdG = b.stddev_gap_s ?? cooldownS * 0.2;
          if (gap > b.avg_gap_s + 2 * sdG) {
            issues.push({ severity: 'warning', category: 'cooldown_delay', cd_name: name,
              timestamp_ms: Math.round(cast_times_s[i] * 1000),
              message: `${name} at ${_fmt(cast_times_s[i])}: ${gap.toFixed(0)}s gap vs top-parse avg ${b.avg_gap_s.toFixed(0)}s ±${(b.stddev_gap_s ?? cooldownS * 0.2).toFixed(0)}s.` });
          }
        } else if (gap > cooldownS * 1.2) {
          issues.push({ severity: 'warning', category: 'cooldown_delay', cd_name: name,
            timestamp_ms: Math.round(cast_times_s[i] * 1000),
            message: `${name} held ${(gap - cooldownS).toFixed(0)}s past reset at ${_fmt(cast_times_s[i])}.` });
        }
      }

      if (b?.hold_targets) {
        for (const [idxStr, target] of Object.entries(b.hold_targets)) {
          const k = parseInt(idxStr, 10) - 1;
          if (k >= cast_times_s.length) continue;
          const playerT = cast_times_s[k];
          const tol = Math.max(target.stddev_s ?? 20, 15);
          if (playerT < target.target_s - tol) {
            suggestions.push({ severity: 'info', category: 'hold_suggestion',
              timestamp_ms: Math.round(playerT * 1000),
              message: `${name} use ${idxStr} at ${_fmt(playerT)} — ${target.count}/${target.total_samples} top parsers hold until ~${_fmt(target.target_s)}.`,
              details: { remedy: `Consider holding ${name} until ~${_fmt(target.target_s)}.`, cd_name: name } });
          }
        }
      }
    }

    if (issues.length) findings.push(...issues);
    else if (uses > 0) findings.push({ severity: 'success', category: 'cooldown_usage', cd_name: name,
      message: `${name} — ${uses}/${expected} uses.` });
    if (uses > 0) findings.push(...suggestions);
  }

  _sortBySeverity(findings);
  return findings;
}

function _computePlayerDefensiveWindows(
  topDefWindows: BurstWindow[], dtEvents: WclEvent[], fStart: number,
): PlayerBurstWindow[] {
  const sorted = dtEvents
    .filter(e => e.timestamp >= fStart && ((e.amount || 0) + (e.absorbed || 0)) > 0)
    .sort((a, b) => a.timestamp - b.timestamp);
  const totalDmg = sorted.reduce((s, e) => s + (e.amount || 0) + (e.absorbed || 0), 0) || 1;

  return topDefWindows.map(dw => {
    const winLenS = dw.window_length_s ?? 8;
    const winEvents = sorted.filter(e => {
      const tS = (e.timestamp - fStart) / 1000;
      return tS >= dw.time_s && tS < dw.time_s + winLenS;
    });
    const winTotal = winEvents.reduce((s, e) => s + (e.amount || 0) + (e.absorbed || 0), 0);
    const byAb: Record<number, number> = {};
    for (const e of winEvents) {
      if (e.abilityGameID) byAb[e.abilityGameID] = (byAb[e.abilityGameID] || 0) + (e.amount || 0) + (e.absorbed || 0);
    }
    const ability_breakdown = Object.entries(byAb).sort((a, b) => b[1] - a[1]).slice(0, 6)
      .map(([sid, dmg]) => ({ spell_id: parseInt(sid, 10), pct: Math.round(dmg / (winTotal || 1) * 1000) / 1000 }));
    return { time_s: dw.time_s, pct_of_total: Math.round(winTotal / totalDmg * 1000) / 1000, ability_breakdown };
  });
}

function _analyzeDefensives(
  defs: RulebookDefensive[], castEvents: WclEvent[], buffEvents: WclEvent[],
  dtEvents: WclEvent[], fStart: number, fEnd: number,
): PlayerDefensive[] {
  if (!defs.length) return [];
  const rel = (ts: number) => ts - fStart;
  // Pre-filter damage-taken events once instead of re-scanning per window.
  const dmgTaken = dtEvents.filter(e => e.type === 'damage');
  const buffWin: Record<number, [number, number | null][]> = {};
  for (const e of buffEvents) {
    const sid = e.abilityGameID, tS = rel(e.timestamp) / 1000;
    if (e.type === 'applybuff') (buffWin[sid] ??= []).push([tS, null]);
    else if (e.type === 'removebuff') {
      for (let i = (buffWin[sid]?.length ?? 0) - 1; i >= 0; i--)
        if (buffWin[sid][i][1] === null) { buffWin[sid][i][1] = tS; break; }
    }
  }
  const dmgInWindow = (wS: number, wE: number): number =>
    dmgTaken.reduce((s, e) => {
      const t = rel(e.timestamp) / 1000; return t >= wS && t <= wE ? s + (e.amount || 0) + (e.absorbed || 0) : s;
    }, 0);
  return defs.map(def => {
    const { spell_id: sid, duration: dur = 0 } = def;
    let windows = (buffWin[sid] || []).map(([wS, wE]) => {
      const end = wE ?? (wS + (dur || 5));
      return { start_s: Math.round(wS * 10) / 10, end_s: Math.round(end * 10) / 10, dmg_during: Math.round(dmgInWindow(wS, end)) };
    });
    if (!windows.length) {
      windows = castEvents.filter(c => c.type === 'cast' && c.abilityGameID === sid && c.timestamp >= fStart && c.timestamp <= fEnd)
        .map(c => {
          const tS = rel(c.timestamp) / 1000, wE = tS + (dur || 5);
          return { start_s: Math.round(tS * 10) / 10, end_s: Math.round(wE * 10) / 10, dmg_during: Math.round(dmgInWindow(tS, wE)) };
        });
    }
    const cast_times_s = windows.map(w => w.start_s).sort((a, b) => a - b);
    return { name: def.name, spell_id: sid, cooldown: def.cooldown, uses: windows.length, cast_times_s, windows };
  });
}

function _analyzeDamageTaken(
  dtEvents: WclEvent[], abilityMap: Record<string, { name: string }>, fStart: number, fEnd: number,
): { segmentPcts: number[]; top: Array<{ spell_id: number; name: string; damage: number; pct: number }>; total: number } {
  const fightDurS = (fEnd - fStart) / 1000, segS = 30;
  const nSegs = Math.max(1, Math.floor(fightDurS / segS) + 1);
  const segs = Array(nSegs).fill(0);
  const byAb: Record<number, number> = {};
  for (const e of dtEvents) {
    const amt = (e.amount || 0) + (e.absorbed || 0); if (!amt) continue;
    const tS = (e.timestamp - fStart) / 1000;
    segs[Math.min(Math.floor(tS / segS), nSegs - 1)] += amt;
    if (e.abilityGameID) byAb[e.abilityGameID] = (byAb[e.abilityGameID] || 0) + amt;
  }
  const total = segs.reduce((a, b) => a + b, 0);
  const segmentPcts = segs.map(s => total ? Math.round(s / total * 10000) / 10000 : 0);
  const top = Object.entries(byAb).sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([sid, dmg]) => ({ spell_id: parseInt(sid, 10), name: abilityMap[sid]?.name || '', damage: Math.round(dmg), pct: total ? Math.round(dmg / total * 1000) / 1000 : 0 }));
  return { segmentPcts, top, total: Math.round(total) };
}

function _sortBySeverity(findings: AnalysisFinding[]): void {
  const order: Record<Severity, number> = { critical: 0, warning: 1, info: 2, hold_suggestion: 2, success: 3 };
  findings.sort((a, b) => (order[a.severity] ?? 4) - (order[b.severity] ?? 4));
}
