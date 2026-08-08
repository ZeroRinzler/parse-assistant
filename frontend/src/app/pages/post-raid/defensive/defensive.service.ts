import { Injectable, inject } from '@angular/core';
import { WclApiService } from '../../../core/services/wcl-api';
import { WclEvent, WclReport } from '../../../core/models/wcl.models';
import {
  AnalysisFinding, BurstWindow, PlayerBurstWindow, PlayerDefensive,
} from '../../../core/models/analysis.models';
import { PerDefensiveBenchmark } from '../../../core/models/encounter.models';
import { ComparisonWindow, WindowStatus, RangeRow } from '../../../core/models/window-comparison.models';
import { ClipAnchor } from '../../../core/models/capture.models';
import { logWarn } from '../../../core/log';
import { Result, LoadError, ok } from '../../../core/result';
import { toLoadError } from '../../../core/http-load-error';
import { holdSuggestionFindings } from '../../../shared/analysis/hold-targets';
import {
  benchExpectedUses, fmtClock, isOutlierAbove, sortBySeverity,
} from '../../../shared/analysis/analysis-math';
import { TimedEvent, normalizeAbilityId, relativeS, windowSpells, withRelativeS } from '../../../shared/analysis/wcl-projections';
import {
  DEFENSIVE_DATA_SOURCE, DefensiveBench, DefensivePlanMeta, BakedAbility,
} from './defensive-data-source';

type AbilityIcons = Record<number, BakedAbility>;

export interface DefensiveMapAnchor {
  timeS: number;
  refGameId: number | null;
  /** 0/undefined for a point-in-time finding cast. */
  windowLengthS?: number;
}

export interface DefensiveView {
  findings: AnalysisFinding[];
  spellIdsByName: Record<string, number>;
  iconByName: Record<string, string>;
  windows: ComparisonWindow[];
  anchors: DefensiveMapAnchor[];
  clipAnchors: ClipAnchor[];
}

export interface DefensivePlanRow {
  name: string;
  spellId: number | null;
  /** Empty string when there is no art. */
  icon: string;
  uses: number | null;
  firstCastS: number | null;
  windowsS: number[];
  holds: { castIndex: number; targetS: number }[];
  rule: string | null;
}

/** Bench-only defensive plan; an `ok` result implies the top-parse bench exists. */
export interface DefensivePlanView {
  rows: DefensivePlanRow[];
}

const dmgOf = (event: WclEvent): number => (event.amount || 0) + (event.absorbed || 0);

/** Lost/unused + first-cast checks run only when at least this share of top parses used the defensive. */
const MIN_USE_SHARE_FRAC = 0.5;

function defensiveUsedShare(bench: PerDefensiveBenchmark): number {
  return bench.used_sample_count / bench.sample_count;
}

type DefensiveUsageWindow = PlayerDefensive['windows'][number];

/**
 * Each measured buff span with damage taken during it; falls back to point casts (zero
 * span) when there is no self-buff. Never invents a rulebook-duration span.
 */
export function buildDefensiveUsageWindows(
  spellId: number,
  buffSpans: [number, number | null][],
  castEvents: TimedEvent[],
  dmgInWindow: (startS: number, endS: number) => number,
  fightEndS: number,
): DefensiveUsageWindow[] {
  const windows = buffSpans.map(([windowStartS, windowEndS]) => {
    // An open buff (no remove) runs to fight end, never a rulebook duration.
    const end = windowEndS ?? fightEndS;
    return { start_s: Math.round(windowStartS * 10) / 10, end_s: Math.round(end * 10) / 10, dmg_during: Math.round(dmgInWindow(windowStartS, end)) };
  });
  if (windows.length) return windows;
  return castEvents
    .filter(cast => cast.type === 'cast' && cast.abilityGameID === spellId)
    .map(cast => cast.atS)
    .filter(timeS => timeS >= 0 && timeS <= fightEndS)
    .map(timeS => ({ start_s: Math.round(timeS * 10) / 10, end_s: Math.round(timeS * 10) / 10, dmg_during: 0 }));
}

/** Per-defensive usage windows (buff-window-centric, point-cast fallback). */
export function analyzeDefensives(
  defensives: DefensivePlanMeta[],
  castEvents: TimedEvent[],
  buffEvents: TimedEvent[],
  dtEvents: TimedEvent[],
  fightEndS: number,
): PlayerDefensive[] {
  if (!defensives.length) return [];
  const dmgTaken = dtEvents.filter(event => event.type === 'damage');
  const buffWin: Record<number, [number, number | null][]> = {};
  for (const event of buffEvents) {
    const spellId = event.abilityGameID;
    const timeS = event.atS;
    if (event.type === 'applybuff') (buffWin[spellId] ??= []).push([timeS, null]);
    else if (event.type === 'removebuff') {
      for (let i = (buffWin[spellId]?.length ?? 0) - 1; i >= 0; i--) {
        if (buffWin[spellId][i][1] === null) { buffWin[spellId][i][1] = timeS; break; }
      }
    }
  }
  const dmgInWindow = (windowStartS: number, windowEndS: number): number =>
    dmgTaken.reduce((sum, event) => {
      const timeS = event.atS;
      return timeS >= windowStartS && timeS <= windowEndS ? sum + dmgOf(event) : sum;
    }, 0);

  return defensives.map(defensive => {
    const spellId = defensive.spell_id;
    const windows = buildDefensiveUsageWindows(spellId, buffWin[spellId] || [], castEvents, dmgInWindow, fightEndS);
    const cast_times_s = windows.map(window => window.start_s).sort((a, b) => a - b);
    const entry: PlayerDefensive = { name: defensive.name, spell_id: spellId, cooldown: defensive.cooldown, uses: windows.length, cast_times_s, windows };
    if (defensive.talent_gated) entry.talent_gated = true;
    return entry;
  });
}

/** Warning findings for each gap between casts that exceeds the top-parse +2σ band. */
export function gapDelayFindings(
  name: string, castTimesS: number[], defBench: PerDefensiveBenchmark,
): AnalysisFinding[] {
  const findings: AnalysisFinding[] = [];
  if (defBench.avg_gap_s == null || defBench.stddev_gap_s == null) return findings;
  const avgGapS = defBench.avg_gap_s;
  for (let i = 1; i < castTimesS.length; i++) {
    const gap = castTimesS[i] - castTimesS[i - 1];
    if (isOutlierAbove(gap, avgGapS, defBench.stddev_gap_s)) {
      findings.push({ severity: 'warning', category: 'cooldown_delay', cd_name: name,
        timestamp_s: castTimesS[i],
        measured: { value: `${gap.toFixed(0)}s`, unit: `avg ${avgGapS.toFixed(0)}s` },
        message: `${name} at ${fmtClock(castTimesS[i])}: ${gap.toFixed(0)}s gap, top ${avgGapS.toFixed(0)}s.`,
        details: { remedy: `Use ${name} sooner after it resets.` }, occurrences: [] });
    }
  }
  return findings;
}


/** Lost / delayed / hold-suggestion findings for ONE defensive vs its top-parse benchmark. */
export function analyzeOneDefensive(
  defensive: PlayerDefensive,
  defBench: PerDefensiveBenchmark | undefined,
  fightDurS: number,
): AnalysisFinding[] {
  const { name, uses, cast_times_s } = defensive;

  if (defensive.talent_gated && uses === 0) return [];

  if (!defBench) {
    return uses > 0
      ? [{ severity: 'success', category: 'cooldown_usage', cd_name: name, message: `${name}: ${uses} uses (no bench data).`, occurrences: [] }]
      : [];
  }

  const { expected, floor } = benchExpectedUses(fightDurS, defBench.uses_per_min);
  const issues: AnalysisFinding[] = [];

  // Lost-use and late-first-use checks need a majority of top parses to use this defensive:
  // a situational one most skip has a noisy expected count, so flagging it is a false positive.
  const majorityUse = defensiveUsedShare(defBench) >= MIN_USE_SHARE_FRAC;

  if (majorityUse && uses === 0 && expected >= 1) {
    issues.push({ severity: 'critical', category: 'lost_cooldown', cd_name: name, timestamp_s: undefined,
      measured: { value: `0 / ${expected}`, unit: 'use(s)' },
      message: `${name} unused. Expected ${expected} on a ${fmtClock(fightDurS)} fight.`,
      details: { remedy: `Use ${name} ${expected}x this fight.` }, occurrences: [] });
  } else if (majorityUse && uses > 0 && uses < floor) {
    issues.push({ severity: 'critical', category: 'lost_cooldown', cd_name: name, timestamp_s: undefined,
      measured: { value: `${uses} / ${expected}`, unit: 'use(s)' },
      message: `${name}: ${uses} uses, expected ${expected}. ${floor - uses} lost.`,
      details: { remedy: `Use ${name} ${floor - uses}x more.` }, occurrences: [] });
  }

  const suggestions: AnalysisFinding[] = [];
  if (cast_times_s?.length) {
    const firstS = cast_times_s[0];
    if (majorityUse && isOutlierAbove(firstS, defBench.avg_first_cast_s, defBench.stddev_first_cast_s)) {
      issues.push({ severity: 'warning', category: 'cooldown_delay', cd_name: name,
        timestamp_s: firstS,
        measured: { value: `+${(firstS - defBench.avg_first_cast_s).toFixed(0)}s`, unit: `top ${fmtClock(defBench.avg_first_cast_s)}` },
        message: `${name} first used at ${fmtClock(firstS)}, ${(firstS - defBench.avg_first_cast_s).toFixed(0)}s late. Top: ${fmtClock(defBench.avg_first_cast_s)}.`,
        details: { remedy: `Use ${name} earlier.` }, occurrences: [] });
    }
    issues.push(...gapDelayFindings(name, cast_times_s, defBench));
    suggestions.push(...holdSuggestionFindings(name, cast_times_s, defBench.hold_targets));
  }

  const result = issues.length
    ? issues
    : (uses > 0 ? [{ severity: 'success', category: 'cooldown_usage', cd_name: name, message: `${name} - ${uses}/${expected} uses.`, occurrences: [] } as AnalysisFinding] : []);
  if (uses > 0) result.push(...suggestions);
  return result;
}

/** Lost / delayed / hold-suggestion findings per defensive, vs top-parse benchmarks. */
export function analyzeDefensiveFindings(
  playerDefensives: PlayerDefensive[],
  perDefBench: Record<string, PerDefensiveBenchmark>,
  fightDurS: number,
): AnalysisFinding[] {
  const findings: AnalysisFinding[] = [];
  for (const defensive of playerDefensives) {
    findings.push(...analyzeOneDefensive(defensive, perDefBench[defensive.name], fightDurS));
  }
  sortBySeverity(findings);
  return findings;
}

/** Player damage taken inside each top-parse defensive window (top 6 abilities). */
export function computePlayerDefensiveWindows(topDefWindows: BurstWindow[], dtEvents: TimedEvent[]): PlayerBurstWindow[] {
  const sorted = dtEvents
    .filter(event => event.atS >= 0 && dmgOf(event) > 0)
    .sort((a, b) => a.atS - b.atS);

  return topDefWindows.map(window => {
    const inWindow = (tsS: number): boolean => tsS >= window.time_s && tsS < window.time_s + window.window_length_s;
    const winEvents = sorted.filter(event => inWindow(event.atS));
    const winTotal = winEvents.reduce((sum, event) => sum + dmgOf(event), 0);
    const byAbility: Record<number, number> = {};
    for (const event of winEvents) {
      if (!event.abilityGameID) continue;
      const spellId = normalizeAbilityId(event.abilityGameID);
      byAbility[spellId] = (byAbility[spellId] || 0) + dmgOf(event);
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

/** True when any player defensive span overlaps [time_s - near, end + near]. */
export function playerCoveredWindow(
  window: BurstWindow, playerDefensive: PlayerDefensive | undefined, nearS = WINDOW_NEAR_S,
): boolean {
  if (!playerDefensive) return false;
  const lo = window.time_s - nearS;
  const hi = window.time_s + window.window_length_s + nearS;
  return playerDefensive.windows.some(span => span.start_s <= hi && span.end_s >= lo);
}

/** Annotations naming whether the expected defensive was pressed; do not set the status. */
const NOTE_COVERED = 'covered';
const NOTE_NO_DEFENSIVE = 'no defensive used';
const NOTE_USED_WRONGLY = 'defensive used wrongly';
const NOTE_NEEDED_UNUSED = 'defensive needed, unused';

/**
 * Status is driven by damage TAKEN vs the band (less is better): at or below the band edge
 * (topMax + stddev) is good, strictly above is bad. Coverage only annotates, never gates.
 */
export function defensiveWindowStatus(
  playerDamage: number | null,
  topMax: number,
  stddev: number,
  notReached: boolean,
  covered: boolean,
): { status: WindowStatus; icon: string; note: string } {
  if (notReached) return { status: 'muted', icon: 'schedule', note: '' };
  if (playerDamage === null) return { status: 'muted', icon: 'help_outline', note: '' };
  const aboveBand = playerDamage > topMax + stddev;
  if (aboveBand) {
    return { status: 'bad', icon: 'error', note: covered ? NOTE_USED_WRONGLY : NOTE_NEEDED_UNUSED };
  }
  return { status: 'good', icon: 'check_circle', note: covered ? NOTE_COVERED : NOTE_NO_DEFENSIVE };
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

/** Map anchor for a defensive window: when to seek and the dominant enemy. */
export function defensiveMapAnchor(window: BurstWindow): DefensiveMapAnchor {
  return {
    timeS: window.time_s,
    refGameId: window.ref_game_id ?? null,
    windowLengthS: window.window_length_s,
  };
}

/** Clip anchor for a defensive window: its span plus the stable memoization key. */
export function defensiveClipAnchor(window: BurstWindow, index: number): ClipAnchor {
  return { timeS: window.time_s, windowLengthS: window.window_length_s, key: `defensive-${index}` };
}

/** Point anchor keyed by the exact cast second, so two findings in one second stay distinct. */
export function defensiveFindingClipAnchor(timestampS: number): ClipAnchor {
  return { timeS: timestampS, windowLengthS: 0, key: `defensive-find-${timestampS}` };
}

export interface DefensiveWindowsInput {
  topWindows: BurstWindow[];
  playerWindows: PlayerBurstWindow[];
  playerDefensives: PlayerDefensive[];
  fightDurationS: number;
  abilities: AbilityIcons;
}

/**
 * Pairs each top-parse defensive window with the player's damage taken inside it (by index).
 * A window starting past the player's fight length is "not reached" and muted.
 */
export function buildDefensiveWindows(
  { topWindows, playerWindows, playerDefensives, fightDurationS, abilities }: DefensiveWindowsInput,
): { windows: ComparisonWindow[]; anchors: DefensiveMapAnchor[]; clipAnchors: ClipAnchor[] } {
  const windows: ComparisonWindow[] = [];
  const anchors: DefensiveMapAnchor[] = [];
  const clipAnchors: ClipAnchor[] = [];
  topWindows.forEach((window, index) => {
    const notReached = window.time_s > fightDurationS;
    const playerWindow = notReached ? null : (playerWindows[index] ?? null);
    const playerDamage = playerWindow?.window_damage ?? null;
    const defensiveName = window.defensive_name ?? window.common_defensives?.[0] ?? '';
    const playerDefensive = playerDefensives.find(entry => entry.name === defensiveName);
    const covered = playerCoveredWindow(window, playerDefensive);
    const { status, icon, note } = defensiveWindowStatus(playerDamage, window.dmg_max, window.dmg_stddev, notReached, covered);
    const labels = window.spell_id == null && defensiveName ? [defensiveName] : [];
    if (note) labels.push(note);
    windows.push({
      timeStartS: window.time_s,
      timeEndS: window.time_s + window.window_length_s,
      spells: windowSpells(window.spell_id != null ? [window.spell_id] : [], abilities),
      labels,
      status,
      statusIcon: icon,
      overview: { label: '', icon: '', playerPct: playerDamage, topAvg: window.dmg_avg, topMin: window.dmg_min, topMax: window.dmg_max },
      detailRows: defensiveDetailRows(window.ability_breakdown, playerWindow, abilities),
    });
    anchors.push(defensiveMapAnchor(window));
    clipAnchors.push(defensiveClipAnchor(window, index));
  });
  return { windows, anchors, clipAnchors };
}

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
    const spellId = defensive.spell_id ?? null;
    const ability = spellId != null ? bench.ability_icons[spellId] : undefined;
    if (spellId != null && !ability) logWarn('buildDefensivePlanRows: ability id missing from ability map', spellId);
    return {
      name: defensive.name,
      spellId,
      icon: ability?.icon ?? '',
      uses: benchmark?.avg_uses ?? null,
      firstCastS: benchmark?.avg_first_cast_s ?? null,
      windowsS,
      holds,
      rule: defensive.usage_rule ?? null,
    };
  }).filter(row => row.uses != null || row.firstCastS != null || row.windowsS.length || row.holds.length || row.rule);
}

@Injectable({ providedIn: 'root' })
export class DefensiveFeatureService {
  private readonly source = inject(DEFENSIVE_DATA_SOURCE);
  private readonly wclApi = inject(WclApiService);

  /**
   * Post-raid: player findings + windows card from their own log against the bench. A WCL
   * fetch failure surfaces as an `err`, never a silent bench-only degrade.
   */
  async loadAnalysisView(
    spec: string,
    encounterId: number,
    reportCode: string,
    fightId: number,
    playerId: number,
  ): Promise<Result<DefensiveView, LoadError>> {
    const bench = await this.source.getBench(spec, encounterId);
    if (!bench.ok) return bench;

    try {
      const report: WclReport = await this.wclApi.getReport(reportCode);
      const fight = report.fights.find(entry => entry.id === fightId);
      // A selected fight not yet present (e.g. mid live-sync) is informational, not a failure.
      if (!fight) return ok({ findings: [], spellIdsByName: bench.value.cd_spell_ids, iconByName: {}, windows: [], anchors: [], clipAnchors: [] });
      const fightDurationS = relativeS(fight.endTime, fight.startTime);

      const [casts, buffs, dtEvents] = await Promise.all([
        this.wclApi.getAllEvents(reportCode, fightId, 'Casts', fight.startTime, fight.endTime, playerId),
        this.wclApi.getAllEvents(reportCode, fightId, 'Buffs', fight.startTime, fight.endTime, playerId),
        this.wclApi.getAllEvents(reportCode, fightId, 'DamageTaken', fight.startTime, fight.endTime, playerId),
      ]);

      const dtEventsTimed = withRelativeS(dtEvents, fight.startTime);
      const playerDefensives = analyzeDefensives(
        bench.value.defensives, withRelativeS(casts, fight.startTime), withRelativeS(buffs, fight.startTime), dtEventsTimed, fightDurationS,
      );
      const findings = bench.value.defensives.length && playerDefensives.length
        ? analyzeDefensiveFindings(playerDefensives, bench.value.per_defensive_benchmarks, fightDurationS)
        : [];

      const playerWindows = computePlayerDefensiveWindows(bench.value.defensive_windows, dtEventsTimed);
      const iconByName: Record<string, string> = {};
      for (const [name, spellId] of Object.entries(bench.value.cd_spell_ids)) {
        iconByName[name] = bench.value.ability_icons[spellId].icon;
      }
      const { windows, anchors, clipAnchors } = buildDefensiveWindows({
        topWindows: bench.value.defensive_windows, playerWindows, playerDefensives, fightDurationS, abilities: bench.value.ability_icons,
      });
      return ok({ findings, spellIdsByName: bench.value.cd_spell_ids, iconByName, windows, anchors, clipAnchors });
    } catch (cause) {
      logWarn(`DefensiveFeatureService.loadAnalysisView ${reportCode}:${fightId}`, cause);
      return toLoadError(cause, 'defensive.player-view');
    }
  }

  /** Pre-fight entry: the bench-only defensive-plan rows for a spec + encounter. */
  async loadPlan(spec: string, encounterId: number): Promise<Result<DefensivePlanView, LoadError>> {
    const bench = await this.source.getBench(spec, encounterId);
    if (!bench.ok) return bench;
    return ok({ rows: buildDefensivePlanRows(bench.value) });
  }
}
