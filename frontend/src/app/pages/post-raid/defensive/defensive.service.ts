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
import { Result, ok } from '../../../core/result';
import { toLoadError } from '../../../core/transport/http-load-error';
import { holdSuggestionFindings } from '../../../shared/analysis/hold-targets';
import { buildAuraWindows } from '../../../shared/analysis/aura-windows';
import { benchExpectedUses, sortBySeverity } from '../../../shared/analysis/analysis-math';
import {
  CadenceVoice, cadencePlanUsage, checkFirstCastDelay, checkGaps, checkLostUses, holdsOf, usedByMajority,
} from '../../../shared/analysis/cast-cadence';
import { TimedEvent, normalizeAbilityId, relativeS, resolveAbility, windowSpells, withRelativeS } from '../../../shared/analysis/wcl-projections';
import {
  DEFENSIVE_DATA_SOURCE, DefensiveBench, DefensivePlanMeta, BakedAbility,
} from './defensive-data-source';

type AbilityIcons = Record<number, BakedAbility>;

export interface DefensiveMapAnchor {
  timeS: number;
  refGameId: number | null;
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
  icon: string;
  /** Median casts among the parses that used it at least once; null when none did. */
  typicalUses: number | null;
  usedSampleCount: number;
  sampleCount: number;
  firstCastS: number | null;
  windowsS: number[];
  holds: { castIndex: number; targetS: number }[];
  rule: string | null;
}

export interface DefensivePlanView {
  rows: DefensivePlanRow[];
}

const dmgOf = (event: WclEvent): number => (event.amount ?? 0) + (event.absorbed ?? 0);

const DEFENSIVE_VOICE: CadenceVoice = {
  unit: 'use(s)',
  firstCastPhrase: 'was first used at',
  gapNoun: 'uses',
  underuseRemedy: (name, missing) => `Use ${name} ${missing}x more.`,
  firstCastRemedy: name => `Use ${name} earlier.`,
  gapRemedy: name => `Use ${name} sooner after it resets.`,
};

type DefensiveUsageWindow = PlayerDefensive['windows'][number];

// Falls back to point casts (zero span) when there is no self-buff; never invents a rulebook-duration span.
export function buildDefensiveUsageWindows(
  spellId: number,
  buffSpans: [number, number | null][],
  castEvents: TimedEvent[],
  fightEndS: number,
): DefensiveUsageWindow[] {
  const windows = buffSpans.map(([windowStartS, windowEndS]) => {
    // An open buff (no remove) runs to fight end, never a rulebook duration.
    const end = windowEndS ?? fightEndS;
    return { start_s: Math.round(windowStartS * 10) / 10, end_s: Math.round(end * 10) / 10 };
  });
  if (windows.length) return windows;
  return castEvents
    .filter(cast => cast.type === 'cast' && cast.abilityGameID === spellId)
    .map(cast => cast.atS)
    .filter(timeS => timeS >= 0 && timeS <= fightEndS)
    .map(timeS => ({ start_s: Math.round(timeS * 10) / 10, end_s: Math.round(timeS * 10) / 10 }));
}

export function analyzeDefensives(
  defensives: DefensivePlanMeta[],
  castEvents: TimedEvent[],
  buffEvents: TimedEvent[],
  fightEndS: number,
): PlayerDefensive[] {
  if (!defensives.length) return [];
  const buffWin = buildAuraWindows(buffEvents);

  return defensives.map(defensive => {
    const spellId = defensive.spell_id;
    const windows = buildDefensiveUsageWindows(spellId, buffWin.get(spellId) ?? [], castEvents, fightEndS);
    const cast_times_s = windows.map(window => window.start_s).sort((a, b) => a - b);
    const entry: PlayerDefensive = { name: defensive.name, uses: windows.length, cast_times_s, windows };
    if (defensive.talent_gated) entry.talent_gated = true;
    return entry;
  });
}

function usageSuccessFindings(name: string, uses: number, expected: number): AnalysisFinding[] {
  if (uses === 0) return [];
  return [{ severity: 'success', category: 'cooldown_usage', cd_name: name,
    message: `${name} - ${uses}/${expected} uses.`, occurrences: [] }];
}

function unbenchedFindings(name: string, uses: number): AnalysisFinding[] {
  if (uses === 0) return [];
  return [{ severity: 'success', category: 'cooldown_usage', cd_name: name,
    message: `${name} was used ${uses} times. No top-parse data to compare against.`, occurrences: [] }];
}

export function analyzeOneDefensive(
  defensive: PlayerDefensive,
  defBench: PerDefensiveBenchmark | undefined,
  fightDurS: number,
): AnalysisFinding[] {
  const { name, uses } = defensive;

  if (defensive.talent_gated && uses === 0) return [];

  if (!defBench) return unbenchedFindings(name, uses);

  const { expected, floor } = benchExpectedUses(fightDurS, defBench.uses_per_min);
  const castTimesS = defensive.cast_times_s ?? [];

  const issues: AnalysisFinding[] = [];
  // A situational defensive most parses skip has a noisy expected count, so flagging it without majority use is a false positive.
  if (usedByMajority(defBench)) {
    const lost = checkLostUses(DEFENSIVE_VOICE, name, uses, expected, floor, fightDurS);
    if (lost) issues.push(lost);
    const lateFirst = checkFirstCastDelay(DEFENSIVE_VOICE, name, castTimesS, defBench);
    if (lateFirst) issues.push(lateFirst);
  }
  issues.push(...checkGaps(DEFENSIVE_VOICE, name, castTimesS, defBench));

  const result = issues.length ? issues : usageSuccessFindings(name, uses, expected);
  if (uses > 0) result.push(...holdSuggestionFindings(name, castTimesS, defBench.hold_targets));
  return result;
}

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
      byAbility[spellId] = (byAbility[spellId] ?? 0) + dmgOf(event);
    }
    const ability_breakdown = Object.entries(byAbility)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([sid, damage]) => ({ spell_id: parseInt(sid, 10), damage: Math.round(damage) }));
    return { window_damage: Math.round(winTotal), ability_breakdown };
  });
}

const WINDOW_NEAR_S = 3;

export function playerCoveredWindow(
  window: BurstWindow, playerDefensive: PlayerDefensive | undefined,
): boolean {
  if (!playerDefensive) return false;
  const lo = window.time_s - WINDOW_NEAR_S;
  const hi = window.time_s + window.window_length_s + WINDOW_NEAR_S;
  return playerDefensive.windows.some(span => span.start_s <= hi && span.end_s >= lo);
}

/** Annotations naming whether the expected defensive was pressed; do not set the status. */
const NOTE_COVERED = 'covered';
const NOTE_NO_DEFENSIVE = 'no defensive used';
const NOTE_USED_WRONGLY = 'defensive used wrongly';
const NOTE_NEEDED_UNUSED = 'defensive needed, unused';

// Status is driven by damage TAKEN vs the band (less is better); coverage only annotates, never gates.
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

export function defensiveDetailRows(
  abilityBreakdown: BurstWindow['ability_breakdown'],
  playerWindow: PlayerBurstWindow | null,
  abilities: AbilityIcons,
): RangeRow[] {
  const playerByAbility: Record<number, { damage: number }> = {};
  for (const ability of playerWindow?.ability_breakdown ?? []) playerByAbility[ability.spell_id] = ability;
  return abilityBreakdown.map(ability => {
    const baked = resolveAbility(abilities, ability.spell_id, 'defensiveDetailRows');
    return {
      spellId: ability.spell_id,
      label: baked.name,
      icon: baked.icon,
      playerPct: playerByAbility[ability.spell_id]?.damage ?? null,
      topAvg: ability.avg_damage,
      topMin: ability.min_damage,
      topMax: ability.max_damage,
    };
  });
}

export function defensiveMapAnchor(window: BurstWindow): DefensiveMapAnchor {
  return {
    timeS: window.time_s,
    refGameId: window.ref_game_id ?? null,
    windowLengthS: window.window_length_s,
  };
}

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

// A window starting past the player's fight length is "not reached" and muted.
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
    const defensiveName = window.defensive_name ?? '';
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

function defensivePlanRow(
  defensive: DefensivePlanMeta,
  benchmark: PerDefensiveBenchmark | undefined,
  windowsS: number[],
  abilities: AbilityIcons,
): DefensivePlanRow {
  const spellId = defensive.spell_id;
  const ability = abilities[spellId];
  if (!ability) logWarn('buildDefensivePlanRows: ability id missing from ability map', spellId);
  return {
    name: defensive.name,
    spellId,
    icon: ability?.icon ?? '',
    ...cadencePlanUsage(benchmark),
    windowsS,
    holds: holdsOf(benchmark),
    rule: defensive.usage_rule ?? null,
  };
}

export function buildDefensivePlanRows(bench: DefensiveBench | null): DefensivePlanRow[] {
  if (!bench?.defensives.length) return [];
  const windows = bench.defensive_windows;
  return bench.defensives.map(defensive => defensivePlanRow(
    defensive,
    bench.per_defensive_benchmarks[defensive.name],
    windows.filter(window => window.defensive_name === defensive.name).map(window => window.time_s).sort((a, b) => a - b),
    bench.ability_icons,
  )).filter(row => row.typicalUses != null || row.firstCastS != null || row.windowsS.length || row.holds.length || row.rule);
}

@Injectable({ providedIn: 'root' })
export class DefensiveFeatureService {
  private readonly source = inject(DEFENSIVE_DATA_SOURCE);
  private readonly wclApi = inject(WclApiService);

  // A WCL fetch failure surfaces as an err, never a silent bench-only degrade.
  async loadAnalysisView(
    spec: string,
    encounterId: number,
    reportCode: string,
    fightId: number,
    playerId: number,
  ): Promise<Result<DefensiveView>> {
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
        bench.value.defensives, withRelativeS(casts, fight.startTime), withRelativeS(buffs, fight.startTime), fightDurationS,
      );
      const findings = bench.value.defensives.length && playerDefensives.length
        ? analyzeDefensiveFindings(playerDefensives, bench.value.per_defensive_benchmarks, fightDurationS)
        : [];

      const playerWindows = computePlayerDefensiveWindows(bench.value.defensive_windows, dtEventsTimed);
      const iconByName: Record<string, string> = {};
      for (const [name, spellId] of Object.entries(bench.value.cd_spell_ids)) {
        const ability = bench.value.ability_icons[spellId];
        if (!ability) logWarn('loadAnalysisView: ability id missing from ability map', spellId);
        iconByName[name] = ability?.icon ?? '';
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

  async loadPlan(spec: string, encounterId: number): Promise<Result<DefensivePlanView>> {
    const bench = await this.source.getBench(spec, encounterId);
    if (!bench.ok) return bench;
    return ok({ rows: buildDefensivePlanRows(bench.value) });
  }
}
