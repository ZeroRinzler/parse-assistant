import { Injectable, inject } from '@angular/core';
import { WclApiService } from '../../../core/services/wcl-api';
import {
  AnalysisFinding, BurstWindow, PlayerBurstWindow, PlayerDefensive,
} from '../../../core/models/analysis.models';
import { PerDefensiveBenchmark } from '../../../core/models/encounter.models';
import { ComparisonWindow, WindowStatus } from '../../../core/models/window-comparison.models';
import { ClipAnchor } from '../../../core/models/capture.models';
import { logWarn } from '../../../core/log';
import { Result, ok } from '../../../core/result';
import { holdSuggestionFindings } from '../../../shared/analysis/hold-targets';
import { buildAuraWindows } from '../../../shared/analysis/aura-windows';
import { benchExpectedUses, sortBySeverity } from '../../../shared/analysis/analysis-math';
import {
  CadenceVoice, cadencePlanUsage, checkFirstCastDelay, checkGaps, checkLostUses, holdsOf, usedByMajority,
} from '../../../shared/analysis/cast-cadence';
import { AbilityIcons, TimedEvent, withRelativeS } from '../../../shared/analysis/wcl-projections';
import { WindowView, WindowViewAdapter, buildWindowView, playerWindowDamage } from '../../../shared/analysis/window-view';
import { PullContext, PullRef, analyzePull } from '../../../shared/analysis/pull-context';
import {
  DEFENSIVE_DATA_SOURCE, DefensiveBench, DefensivePlanMeta,
} from './defensive-data-source';

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

const TOP_DAMAGE_SOURCES = 6;

export function computePlayerDefensiveWindows(topDefWindows: BurstWindow[], dtEvents: TimedEvent[]): PlayerBurstWindow[] {
  return playerWindowDamage(topDefWindows, dtEvents, { maxAbilities: TOP_DAMAGE_SOURCES });
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

function defensiveAdapter(playerDefensives: PlayerDefensive[]): WindowViewAdapter<DefensiveMapAnchor> {
  const coveredBy = (window: BurstWindow): boolean =>
    playerCoveredWindow(window, playerDefensives.find(entry => entry.name === (window.defensive_name ?? '')));
  return {
    status: (window, playerDamage, notReached) =>
      defensiveWindowStatus(playerDamage, window.dmg_max, window.dmg_stddev, notReached, coveredBy(window)),
    chips: window => ({
      spellIds: window.spell_id != null ? [window.spell_id] : [],
      labels: window.spell_id == null && window.defensive_name ? [window.defensive_name] : [],
    }),
    mapAnchor: defensiveMapAnchor,
    clipAnchor: defensiveClipAnchor,
  };
}

export function buildDefensiveWindows(
  { topWindows, playerWindows, playerDefensives, fightDurationS, abilities }: DefensiveWindowsInput,
): WindowView<DefensiveMapAnchor> {
  return buildWindowView({
    topWindows, playerWindows, fightDurationS, abilities, adapter: defensiveAdapter(playerDefensives),
  });
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

    const pull: PullRef = { reportCode, fightId };
    return analyzePull(this.wclApi, pull, {
      logSource: 'DefensiveFeatureService.loadAnalysisView',
      errorId: 'defensive.player-view',
      emptyView: () => ({ findings: [], spellIdsByName: bench.value.cd_spell_ids, iconByName: {}, windows: [], anchors: [], clipAnchors: [] }),
      analyze: context => this.analysisView(bench.value, pull, playerId, context),
    });
  }

  private async analysisView(
    bench: DefensiveBench, pull: PullRef, playerId: number, context: PullContext,
  ): Promise<DefensiveView> {
    const { reportCode, fightId } = pull;
    const { fight, fightDurationS } = context;

    const [casts, buffs, dtEvents] = await Promise.all([
      this.wclApi.getAllEvents(reportCode, fightId, 'Casts', fight.startTime, fight.endTime, playerId),
      this.wclApi.getAllEvents(reportCode, fightId, 'Buffs', fight.startTime, fight.endTime, playerId),
      this.wclApi.getAllEvents(reportCode, fightId, 'DamageTaken', fight.startTime, fight.endTime, playerId),
    ]);

    const dtEventsTimed = withRelativeS(dtEvents, fight.startTime);
    const playerDefensives = analyzeDefensives(
      bench.defensives, withRelativeS(casts, fight.startTime), withRelativeS(buffs, fight.startTime), fightDurationS,
    );
    const findings = bench.defensives.length && playerDefensives.length
      ? analyzeDefensiveFindings(playerDefensives, bench.per_defensive_benchmarks, fightDurationS)
      : [];

    const playerWindows = computePlayerDefensiveWindows(bench.defensive_windows, dtEventsTimed);
    const iconByName: Record<string, string> = {};
    for (const [name, spellId] of Object.entries(bench.cd_spell_ids)) {
      const ability = bench.ability_icons[spellId];
      if (!ability) logWarn('loadAnalysisView: ability id missing from ability map', spellId);
      iconByName[name] = ability?.icon ?? '';
    }
    const { windows, anchors, clipAnchors } = buildDefensiveWindows({
      topWindows: bench.defensive_windows, playerWindows, playerDefensives, fightDurationS, abilities: bench.ability_icons,
    });
    return { findings, spellIdsByName: bench.cd_spell_ids, iconByName, windows, anchors, clipAnchors };
  }

  async loadPlan(spec: string, encounterId: number): Promise<Result<DefensivePlanView>> {
    const bench = await this.source.getBench(spec, encounterId);
    if (!bench.ok) return bench;
    return ok({ rows: buildDefensivePlanRows(bench.value) });
  }
}
