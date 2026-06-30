/**
 * Defensive slice runtime shell + its pure transform functions, colocated.
 *
 * `DefensiveFeatureService` is the imperative shell (components inject only it). It
 * is dual-mode:
 *  - `loadAnalysisView(...)` (post-raid) fetches the player's own log, computes the
 *    player's defensive usage + windows, and assembles the findings + the defensive
 *    windows card view-model against the prepared bench.
 *  - `loadPlan(...)` (pre-fight) returns the bench-only defensive-plan rows.
 *
 * Self-contained per the slice rule: imports ONLY the two API services / the slice
 * `DEFENSIVE_DATA_SOURCE` token + models + `logWarn`. Every calculated field is its
 * own small, exported, individually-tested pure function - no separate vm file.
 */
import { Injectable, inject } from '@angular/core';
import { WclApiService } from '../../../core/services/wcl-api';
import { WclEvent, WclReport } from '../../../core/models/wcl.models';
import {
  AnalysisFinding, BurstWindow, PlayerBurstWindow, PlayerDefensive,
} from '../../../core/models/analysis.models';
import { PerDefensiveBenchmark } from '../../../core/models/encounter.models';
import { ComparisonWindow, WindowStatus, RangeRow, WindowSpell } from '../../../core/models/window-comparison.models';
import { logWarn } from '../../../core/log';
import {
  DEFENSIVE_DATA_SOURCE, DefensiveBench, DefensivePlanMeta, BakedAbility,
} from './defensive-data-source';

/** Spell id -> baked icon + name, complete over every spell the card renders. */
type AbilityIcons = Record<number, BakedAbility>;

/** Anchor for opening the positioning map on a defensive window (emitted as an output). */
export interface DefensiveMapAnchor {
  timeS: number;
  label: string;
  spells: WindowSpell[];
  refGameId: number | null;
}

/** The defensive card view-model: findings + per-window comparison + map anchors. */
export interface DefensiveView {
  findings: AnalysisFinding[];
  /** Defensive name -> spell id, so the findings table links to the right spell. */
  spellIdsByName: Record<string, number>;
  /** Defensive name -> icon filename, so the findings table renders art without a cache. */
  iconByName: Record<string, string>;
  windows: ComparisonWindow[];
  anchors: DefensiveMapAnchor[];
}

/** One /pre defensive-plan row (bench-only). */
export interface DefensivePlanRow {
  name: string;
  spellId: number | null;
  /** Baked icon filename for `wl-game-icon` (empty string when there is no art). */
  icon: string;
  uses: number | null;
  firstCastS: number | null;
  windowsS: number[];
  holds: { castIndex: number; targetS: number }[];
  rule: string | null;
}

/* ----------------------------- shared atoms ----------------------------- */

const dmgOf = (event: WclEvent): number => (event.amount || 0) + (event.absorbed || 0);

/** True when `value` sits more than `sigmas` standard deviations ABOVE the mean. */
export function isOutlierAbove(value: number, mean: number, stddev: number, sigmas = 2): boolean {
  return value > mean + sigmas * stddev;
}

/** Data-driven expected uses + the cohort -1σ floor for a defensive over a fight. */
export function benchExpectedUses(fightDurS: number, upm: { avg: number; stddev: number }): { expected: number; floor: number } {
  const fightMin = fightDurS / 60;
  const expected = Math.round(upm.avg * fightMin);
  const floor = Math.max(0, Math.round(expected - upm.stddev * fightMin));
  return { expected, floor };
}

/** Format seconds as `m:ss` (zero-padded). */
export function fmtClock(seconds: number): string {
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}

const SEVERITY_ORDER: Record<AnalysisFinding['severity'], number> = {
  critical: 0, warning: 1, info: 2, hold_suggestion: 2, success: 3,
};
/** Sort findings in place: critical first, success last. Stable for equal ranks. */
export function sortBySeverity(findings: AnalysisFinding[]): void {
  findings.sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 4) - (SEVERITY_ORDER[b.severity] ?? 4));
}

/* ----------------------------- player defensives ----------------------------- */

/** Build per-defensive usage windows (buff-window-centric, cast+duration fallback). */
export function analyzeDefensives(
  defensives: DefensivePlanMeta[],
  castEvents: WclEvent[],
  buffEvents: WclEvent[],
  dtEvents: WclEvent[],
  fStart: number,
  fEnd: number,
): PlayerDefensive[] {
  if (!defensives.length) return [];
  const rel = (ts: number): number => ts - fStart;
  const dmgTaken = dtEvents.filter(event => event.type === 'damage');
  const buffWin: Record<number, [number, number | null][]> = {};
  for (const event of buffEvents) {
    const spellId = event.abilityGameID;
    const timeS = rel(event.timestamp) / 1000;
    if (event.type === 'applybuff') (buffWin[spellId] ??= []).push([timeS, null]);
    else if (event.type === 'removebuff') {
      for (let i = (buffWin[spellId]?.length ?? 0) - 1; i >= 0; i--) {
        if (buffWin[spellId][i][1] === null) { buffWin[spellId][i][1] = timeS; break; }
      }
    }
  }
  const dmgInWindow = (windowStartS: number, windowEndS: number): number =>
    dmgTaken.reduce((sum, event) => {
      const timeS = rel(event.timestamp) / 1000;
      return timeS >= windowStartS && timeS <= windowEndS ? sum + dmgOf(event) : sum;
    }, 0);

  const fightEndS = (fEnd - fStart) / 1000;
  return defensives.map(defensive => {
    const spellId = defensive.spell_id;
    let windows = (buffWin[spellId] || []).map(([windowStartS, windowEndS]) => {
      // Measured span; an open buff (no remove) runs to fight end - never a rulebook duration.
      const end = windowEndS ?? fightEndS;
      return { start_s: Math.round(windowStartS * 10) / 10, end_s: Math.round(end * 10) / 10, dmg_during: Math.round(dmgInWindow(windowStartS, end)) };
    });
    if (!windows.length) {
      // No self-buff: a cast is a point usage (no rulebook-duration span invented).
      windows = castEvents
        .filter(cast => cast.type === 'cast' && cast.abilityGameID === spellId && cast.timestamp >= fStart && cast.timestamp <= fEnd)
        .map(cast => {
          const timeS = rel(cast.timestamp) / 1000;
          return { start_s: Math.round(timeS * 10) / 10, end_s: Math.round(timeS * 10) / 10, dmg_during: 0 };
        });
    }
    const cast_times_s = windows.map(window => window.start_s).sort((a, b) => a - b);
    const entry: PlayerDefensive = { name: defensive.name, spell_id: spellId, cooldown: defensive.cooldown, uses: windows.length, cast_times_s, windows };
    if (defensive.talent_gated) entry.talent_gated = true;
    return entry;
  });
}

/** Lost / delayed / hold-suggestion findings per defensive, vs top-parse benchmarks. */
export function analyzeDefensiveFindings(
  playerDefensives: PlayerDefensive[],
  perDefBench: Record<string, PerDefensiveBenchmark>,
  fightDurS: number,
): AnalysisFinding[] {
  const findings: AnalysisFinding[] = [];

  for (const defensive of playerDefensives) {
    const { name, uses, cast_times_s } = defensive;
    const defBench = perDefBench[name];
    const issues: AnalysisFinding[] = [];
    const suggestions: AnalysisFinding[] = [];

    if (defensive.talent_gated && uses === 0) continue;

    if (!defBench) {
      if (uses > 0) findings.push({ severity: 'success', category: 'cooldown_usage', cd_name: name,
        message: `${name}: ${uses} uses (no bench data).` });
      continue;
    }

    const { expected, floor } = benchExpectedUses(fightDurS, defBench.uses_per_min);

    if (uses === 0 && expected >= 1) {
      issues.push({ severity: 'critical', category: 'lost_cooldown', cd_name: name, timestamp_ms: undefined,
        measured: { value: `0 / ${expected}`, unit: 'use(s)' },
        message: `${name} unused. Expected ${expected} on a ${fmtClock(fightDurS)} fight.`,
        details: { remedy: `Use ${name} ${expected}x this fight.` } });
    } else if (uses > 0 && uses < floor) {
      issues.push({ severity: 'critical', category: 'lost_cooldown', cd_name: name, timestamp_ms: undefined,
        measured: { value: `${uses} / ${expected}`, unit: 'use(s)' },
        message: `${name}: ${uses} uses, expected ${expected}. ${floor - uses} lost.`,
        details: { remedy: `Use ${name} ${floor - uses}x more.` } });
    }

    if (cast_times_s?.length) {
      const firstS = cast_times_s[0];
      if (isOutlierAbove(firstS, defBench.avg_first_cast_s, defBench.stddev_first_cast_s)) {
        issues.push({ severity: 'warning', category: 'cooldown_delay', cd_name: name,
          timestamp_ms: Math.round(firstS * 1000),
          measured: { value: `+${(firstS - defBench.avg_first_cast_s).toFixed(0)}s`, unit: `top ${fmtClock(defBench.avg_first_cast_s)}` },
          message: `${name} first used at ${fmtClock(firstS)}, ${(firstS - defBench.avg_first_cast_s).toFixed(0)}s late. Top: ${fmtClock(defBench.avg_first_cast_s)}.`,
          details: { remedy: `Use ${name} earlier.` } });
      }

      for (let i = 1; i < cast_times_s.length; i++) {
        const gap = cast_times_s[i] - cast_times_s[i - 1];
        if (defBench.avg_gap_s != null && defBench.stddev_gap_s != null) {
          const sdG = defBench.stddev_gap_s;
          if (isOutlierAbove(gap, defBench.avg_gap_s, sdG)) {
            issues.push({ severity: 'warning', category: 'cooldown_delay', cd_name: name,
              timestamp_ms: Math.round(cast_times_s[i] * 1000),
              measured: { value: `${gap.toFixed(0)}s`, unit: `avg ${defBench.avg_gap_s.toFixed(0)}s` },
              message: `${name} at ${fmtClock(cast_times_s[i])}: ${gap.toFixed(0)}s gap, top ${defBench.avg_gap_s.toFixed(0)}s.`,
              details: { remedy: `Use ${name} sooner after it resets.` } });
          }
        }
      }

      for (const [idxStr, target] of Object.entries(defBench.hold_targets)) {
        const k = parseInt(idxStr, 10) - 1;
        if (k >= cast_times_s.length) continue;
        const playerT = cast_times_s[k];
        const tol = target.stddev_s;
        if (playerT < target.target_s - tol) {
          suggestions.push({ severity: 'info', category: 'hold_suggestion',
            timestamp_ms: Math.round(playerT * 1000),
            measured: { value: fmtClock(playerT), unit: `top ~${fmtClock(target.target_s)}` },
            message: `${name} use ${idxStr} at ${fmtClock(playerT)}. ${target.count}/${target.total_samples} top parses hold to ${fmtClock(target.target_s)}.`,
            details: { remedy: `Hold ${name} to ${fmtClock(target.target_s)}.`, cd_name: name } });
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

/** Player damage taken inside each top-parse defensive window (top 6 abilities). */
export function computePlayerDefensiveWindows(topDefWindows: BurstWindow[], dtEvents: WclEvent[], fStart: number): PlayerBurstWindow[] {
  const sorted = dtEvents
    .filter(event => event.timestamp >= fStart && dmgOf(event) > 0)
    .sort((a, b) => a.timestamp - b.timestamp);

  return topDefWindows.map(window => {
    const inWindow = (tsS: number): boolean => tsS >= window.time_s && tsS < window.time_s + window.window_length_s;
    const winEvents = sorted.filter(event => inWindow((event.timestamp - fStart) / 1000));
    const winTotal = winEvents.reduce((sum, event) => sum + dmgOf(event), 0);
    const byAbility: Record<number, number> = {};
    for (const event of winEvents) {
      if (event.abilityGameID) byAbility[event.abilityGameID] = (byAbility[event.abilityGameID] || 0) + dmgOf(event);
    }
    const ability_breakdown = Object.entries(byAbility)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([sid, damage]) => ({ spell_id: parseInt(sid, 10), damage: Math.round(damage) }));
    return { time_s: window.time_s, window_damage: Math.round(winTotal), ability_breakdown };
  });
}

/** Slack (s) around a top window within which a player defensive still "covers" it. */
const WINDOW_NEAR_S = 3;

/**
 * Did the player have `defensive` active at/near this top-parse window? Window-centric:
 * any player defensive span (or point cast) overlapping [time_s - near, end + near].
 */
export function playerCoveredWindow(
  window: BurstWindow, playerDefensive: PlayerDefensive | undefined, nearS = WINDOW_NEAR_S,
): boolean {
  if (!playerDefensive) return false;
  const lo = window.time_s - nearS;
  const hi = window.time_s + window.window_length_s + nearS;
  return playerDefensive.windows.some(span => span.start_s <= hi && span.end_s >= lo);
}

/**
 * Useful timing: the player covered the window AND faced a big hit under the defensive
 * (their covering span took at least the window's top-parse minimum). Credits using the
 * cooldown on real damage even when the exact alignment is off.
 */
export function playerUsefulTiming(
  window: BurstWindow, playerDefensive: PlayerDefensive | undefined, nearS = WINDOW_NEAR_S,
): boolean {
  if (!playerDefensive) return false;
  const lo = window.time_s - nearS;
  const hi = window.time_s + window.window_length_s + nearS;
  const covering = playerDefensive.windows.filter(span => span.start_s <= hi && span.end_s >= lo);
  if (!covering.length) return false;
  return Math.max(...covering.map(span => span.dmg_during)) >= window.dmg_min;
}

/* ----------------------------- defensive windows view ----------------------------- */

/**
 * Status glyph for one defensive window. Less damage taken is better, so taking
 * MORE than the top-parse range is the problem.
 */
export function defensiveWindowStatus(
  playerDamage: number | null,
  topAvg: number,
  topMax: number,
  stddev: number,
  notReached: boolean,
  covered: boolean,
  usefulTiming: boolean,
): { status: WindowStatus; icon: string } {
  if (notReached) return { status: 'muted', icon: 'schedule' };
  if (playerDamage === null) return { status: 'muted', icon: 'help_outline' };
  // The window is where top parses mitigate a big hit. Not using the defensive here is
  // the real miss; using it on a real hit (useful timing) is credited.
  if (!covered) return { status: 'bad', icon: 'error' };
  if (usefulTiming) return { status: 'good', icon: 'check_circle' };
  if (playerDamage > topMax + stddev) return { status: 'warn', icon: 'warning_amber' };
  if (topAvg > 0 && playerDamage > topAvg + stddev) return { status: 'warn', icon: 'warning_amber' };
  return { status: 'good', icon: 'check_circle' };
}

/** Per-ability comparison rows: player damage taken vs the top-parse range. */
export function defensiveDetailRows(
  abilityBreakdown: BurstWindow['ability_breakdown'],
  playerWindow: PlayerBurstWindow | null,
  abilities: AbilityIcons,
): RangeRow[] {
  const playerByAbility: Record<number, { damage: number }> = {};
  for (const ability of playerWindow?.ability_breakdown ?? []) playerByAbility[ability.spell_id] = ability;
  return abilityBreakdown.map(ability => ({
    spellId: ability.spell_id,
    label: abilities[ability.spell_id].name,
    icon: abilities[ability.spell_id].icon,
    playerPct: playerByAbility[ability.spell_id]?.damage ?? null,
    topAvg: ability.avg_damage,
    topMin: ability.min_damage,
    topMax: ability.max_damage,
  }));
}

/** Header chip for a window's defensive spell, with its baked icon + name. */
function windowSpells(spellId: number | null | undefined, abilities: AbilityIcons): WindowSpell[] {
  return spellId != null ? [{ id: spellId, icon: abilities[spellId].icon, name: abilities[spellId].name }] : [];
}

/** Map anchor for a defensive window: when to seek, label, defensive spell, and the dominant enemy. */
export function defensiveMapAnchor(window: BurstWindow, abilities: AbilityIcons): DefensiveMapAnchor {
  const label = window.defensive_name ?? window.common_defensives?.[0] ?? 'Defensive';
  return {
    timeS: window.time_s,
    label,
    spells: windowSpells(window.spell_id, abilities),
    refGameId: window.ref_game_id ?? null,
  };
}

/**
 * Build the defensive windows card view-model: each top-parse defensive window
 * paired with the player's damage taken inside it (by index), plus a map anchor. A
 * window whose start is past the player's fight length is "not reached" and muted.
 */
export function buildDefensiveWindows(
  topWindows: BurstWindow[],
  playerWindows: PlayerBurstWindow[],
  playerDefensives: PlayerDefensive[],
  fightDurationS: number,
  abilities: AbilityIcons,
): { windows: ComparisonWindow[]; anchors: DefensiveMapAnchor[] } {
  const windows: ComparisonWindow[] = [];
  const anchors: DefensiveMapAnchor[] = [];
  topWindows.forEach((window, index) => {
    const notReached = window.time_s > fightDurationS;
    const playerWindow = notReached ? null : (playerWindows[index] ?? null);
    const playerDamage = playerWindow?.window_damage ?? null;
    const defensiveName = window.defensive_name ?? window.common_defensives?.[0] ?? '';
    const playerDefensive = playerDefensives.find(entry => entry.name === defensiveName);
    const covered = playerCoveredWindow(window, playerDefensive);
    const useful = playerUsefulTiming(window, playerDefensive);
    const { status, icon } = defensiveWindowStatus(playerDamage, window.dmg_avg, window.dmg_max, window.dmg_stddev, notReached, covered, useful);
    const labels = window.spell_id == null && defensiveName ? [defensiveName] : [];
    windows.push({
      timeStartS: window.time_s,
      timeEndS: window.time_s + window.window_length_s,
      spells: windowSpells(window.spell_id, abilities),
      labels,
      status,
      statusIcon: icon,
      overview: { label: '', icon: '', playerPct: playerDamage, topAvg: window.dmg_avg, topMin: window.dmg_min, topMax: window.dmg_max },
      detailRows: defensiveDetailRows(window.ability_breakdown, playerWindow, abilities),
    });
    anchors.push(defensiveMapAnchor(window, abilities));
  });
  return { windows, anchors };
}

/** One warning per consensus defensive window the player neither covered nor usefully pressed. */
export function windowMissFindings(
  topWindows: BurstWindow[],
  playerDefensives: PlayerDefensive[],
  fightDurationS: number,
): AnalysisFinding[] {
  const findings: AnalysisFinding[] = [];
  for (const window of topWindows) {
    if (window.time_s > fightDurationS) continue;
    const name = window.defensive_name ?? window.common_defensives?.[0] ?? '';
    if (!name) continue;
    const playerDefensive = playerDefensives.find(entry => entry.name === name);
    if (playerDefensive?.talent_gated && playerDefensive.uses === 0) continue;
    if (playerCoveredWindow(window, playerDefensive)) continue;
    findings.push({
      severity: 'warning', category: 'defensive_window', cd_name: name,
      timestamp_ms: Math.round(window.time_s * 1000),
      measured: { value: 'none', unit: 'mitigated' },
      message: `${name} window at ${fmtClock(window.time_s)} uncovered. Top parses mitigate here.`,
      details: { remedy: `Use ${name} at ${fmtClock(window.time_s)}.` },
    });
  }
  return findings;
}

/* ----------------------------- pre-fight plan ----------------------------- */

/** Defensive plan rows: when top parsers fire each defensive and how often. */
export function buildDefensivePlanRows(bench: DefensiveBench | null): DefensivePlanRow[] {
  if (!bench?.defensives?.length) return [];
  const benchmarks = bench.per_defensive_benchmarks ?? {};
  const windows = bench.defensive_windows ?? [];
  return bench.defensives.map(defensive => {
    const benchmark = benchmarks[defensive.name];
    const windowsS = windows
      .filter(window => (window.defensive_name ?? window.common_defensives?.[0]) === defensive.name)
      .map(window => window.time_s)
      .sort((a, b) => a - b);
    const holds = benchmark?.majority_hold && benchmark.hold_targets
      ? Object.entries(benchmark.hold_targets)
          .sort((a, b) => Number(a[0]) - Number(b[0]))
          .map(([idx, hold]) => ({ castIndex: Number(idx), targetS: hold.target_s }))
      : [];
    return {
      name: defensive.name,
      spellId: defensive.spell_id ?? null,
      icon: bench.ability_icons[defensive.spell_id].icon,
      uses: benchmark?.avg_uses ?? null,
      firstCastS: benchmark?.avg_first_cast_s ?? null,
      windowsS,
      holds,
      rule: defensive.usage_rule ?? null,
    };
  }).filter(row => row.uses != null || row.firstCastS != null || row.windowsS.length || row.holds.length || row.rule);
}

/* ----------------------------- feature service ---------------------------- */

@Injectable({ providedIn: 'root' })
export class DefensiveFeatureService {
  private readonly source = inject(DEFENSIVE_DATA_SOURCE);
  private readonly wclApi = inject(WclApiService);

  /**
   * Post-raid entry: load the prepared bench, fetch the player's own log (Casts /
   * Buffs / DamageTaken), and build the player's defensive findings + the defensive
   * windows card view-model. Returns an empty view if the bench is absent.
   */
  async loadAnalysisView(
    spec: string,
    encounterId: number,
    reportCode: string,
    fightId: number,
    playerId: number,
  ): Promise<DefensiveView> {
    const bench = await this.source.getDefensiveBench(spec, encounterId);
    if (!bench) return { findings: [], spellIdsByName: {}, iconByName: {}, windows: [], anchors: [] };

    try {
      const report: WclReport = await this.wclApi.getReport(reportCode);
      const fight = report.fights.find(entry => entry.id === fightId);
      if (!fight) return { findings: [], spellIdsByName: bench.cd_spell_ids, iconByName: {}, windows: [], anchors: [] };
      const fStart = fight.startTime;
      const fEnd = fight.endTime;
      const fightDurationS = (fEnd - fStart) / 1000;

      const [casts, buffs, dtEvents] = await Promise.all([
        this.wclApi.getAllEvents(reportCode, fightId, 'Casts', fStart, fEnd, playerId),
        this.wclApi.getAllEvents(reportCode, fightId, 'Buffs', fStart, fEnd, playerId),
        this.wclApi.getAllEvents(reportCode, fightId, 'DamageTaken', fStart, fEnd, playerId),
      ]);

      const playerDefensives = analyzeDefensives(bench.defensives, casts, buffs, dtEvents, fStart, fEnd);
      const findings = bench.defensives.length && playerDefensives.length
        ? analyzeDefensiveFindings(playerDefensives, bench.per_defensive_benchmarks, fightDurationS)
        : [];
      // A finding for each top-parse mitigation window the player did not cover.
      findings.push(...windowMissFindings(bench.defensive_windows, playerDefensives, fightDurationS));
      sortBySeverity(findings);

      const playerWindows = computePlayerDefensiveWindows(bench.defensive_windows, dtEvents, fStart);
      const iconByName: Record<string, string> = {};
      for (const [name, spellId] of Object.entries(bench.cd_spell_ids)) {
        iconByName[name] = bench.ability_icons[spellId].icon;
      }
      const { windows, anchors } = buildDefensiveWindows(bench.defensive_windows, playerWindows, playerDefensives, fightDurationS, bench.ability_icons);
      return { findings, spellIdsByName: bench.cd_spell_ids, iconByName, windows, anchors };
    } catch (err) {
      logWarn(`DefensiveFeatureService.loadAnalysisView ${reportCode}:${fightId}`, err);
      return { findings: [], spellIdsByName: bench.cd_spell_ids, iconByName: {}, windows: [], anchors: [] };
    }
  }

  /** Pre-fight entry: the bench-only defensive-plan rows for a spec + encounter. */
  async loadPlan(spec: string, encounterId: number): Promise<DefensivePlanRow[]> {
    const bench = await this.source.getDefensiveBench(spec, encounterId);
    return buildDefensivePlanRows(bench);
  }
}
