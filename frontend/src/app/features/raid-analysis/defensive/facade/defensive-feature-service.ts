import { Injectable, inject } from '@angular/core';
import { WclApiService } from '../../../../core/wcl/wcl-api-service';
import {
  AnalysisFinding, BurstWindow, PlayerBurstWindow, PlayerDefensive,
} from '../../../../domain/analysis/analysis.models';
import { PerDefensiveBenchmark } from '../../../../domain/encounter/encounter.models';
import { ComparisonWindow, WindowStatus } from '../../../../domain/analysis/window-comparison.models';
import { ClipAnchor } from '../../../../domain/capture/capture.models';
import { Result, Results } from '../../../../core/http/result';
import { benchExpectedUses, sortBySeverity } from '../../../../domain/analysis/analysis-math';
import { CadenceVoice } from '../../../../domain/analysis/cast-cadence-service';
import { WclProjectionsService, AbilityIcons, TimedEvent } from '../../../../domain/analysis/wcl-projections-service';
import { WindowView, WindowViewAdapter } from '../../../../domain/analysis/window-view-service';
import { PullContextService, PullContext, PullRef } from '../../../../domain/analysis/pull-context-service';
import {
  DEFENSIVE_DATA_SOURCE, DefensiveBench, DefensivePlanMeta,
} from '../data-access/defensive-data-source';
import { LoggerService } from '../../../../core/observability/logger-service';
import { HoldTargetsService } from '../../../../domain/analysis/hold-targets-service';
import { AuraWindowsService } from '../../../../domain/analysis/aura-windows-service';
import { CastCadenceService } from '../../../../domain/analysis/cast-cadence-service';
import { WindowViewService } from '../../../../domain/analysis/window-view-service';

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

const TOP_DAMAGE_SOURCES = 6;

const WINDOW_NEAR_S = 3;

/** Annotations naming whether the expected defensive was pressed; do not set the status. */
const NOTE_COVERED = 'covered';
const NOTE_NO_DEFENSIVE = 'no defensive used';
const NOTE_USED_WRONGLY = 'defensive used wrongly';
const NOTE_NEEDED_UNUSED = 'defensive needed, unused';

export interface DefensiveWindowsInput {
  topWindows: BurstWindow[];
  playerWindows: PlayerBurstWindow[];
  playerDefensives: PlayerDefensive[];
  fightDurationS: number;
  abilities: AbilityIcons;
}

@Injectable({ providedIn: 'root' })
export class DefensiveFeatureService {
  private readonly logger = inject(LoggerService);
  private readonly holdTargets = inject(HoldTargetsService);
  private readonly auraWindows = inject(AuraWindowsService);
  private readonly castCadence = inject(CastCadenceService);
  private readonly windowView = inject(WindowViewService);
  private readonly pullContext = inject(PullContextService);
  private readonly wclProjections = inject(WclProjectionsService);
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
    return this.pullContext.analyzePull(this.wclApi, pull, {
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

    const dtEventsTimed = this.wclProjections.withRelativeS(dtEvents, fight.startTime);
    const playerDefensives = this.analyzeDefensives(
      bench.defensives, this.wclProjections.withRelativeS(casts, fight.startTime), this.wclProjections.withRelativeS(buffs, fight.startTime), fightDurationS,
    );
    const findings = bench.defensives.length && playerDefensives.length
      ? this.analyzeDefensiveFindings(playerDefensives, bench.per_defensive_benchmarks, fightDurationS)
      : [];

    const playerWindows = this.computePlayerDefensiveWindows(bench.defensive_windows, dtEventsTimed);
    const iconByName: Record<string, string> = {};
    for (const [name, spellId] of Object.entries(bench.cd_spell_ids)) {
      const ability = bench.ability_icons[spellId];
      if (!ability) this.logger.logWarn('loadAnalysisView: ability id missing from ability map', spellId);
      iconByName[name] = ability?.icon ?? '';
    }
    const { windows, anchors, clipAnchors } = this.buildDefensiveWindows({
      topWindows: bench.defensive_windows, playerWindows, playerDefensives, fightDurationS, abilities: bench.ability_icons,
    });
    return { findings, spellIdsByName: bench.cd_spell_ids, iconByName, windows, anchors, clipAnchors };
  }

  async loadPlan(spec: string, encounterId: number): Promise<Result<DefensivePlanView>> {
    const bench = await this.source.getBench(spec, encounterId);
    if (!bench.ok) return bench;
    return Results.ok({ rows: this.buildDefensivePlanRows(bench.value) });
  }

  // Falls back to point casts (zero span) when there is no self-buff; never invents a rulebook-duration span.
  protected buildDefensiveUsageWindows(
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

  protected analyzeDefensives(
    defensives: DefensivePlanMeta[],
    castEvents: TimedEvent[],
    buffEvents: TimedEvent[],
    fightEndS: number,
  ): PlayerDefensive[] {
    if (!defensives.length) return [];
    const buffWin = this.auraWindows.buildAuraWindows(buffEvents);

    return defensives.map(defensive => {
      const spellId = defensive.spell_id;
      const windows = this.buildDefensiveUsageWindows(spellId, buffWin.get(spellId) ?? [], castEvents, fightEndS);
      const cast_times_s = windows.map(window => window.start_s).sort((a, b) => a - b);
      const entry: PlayerDefensive = { name: defensive.name, uses: windows.length, cast_times_s, windows };
      if (defensive.talent_gated) entry.talent_gated = true;
      return entry;
    });
  }

  private usageSuccessFindings(name: string, uses: number, expected: number): AnalysisFinding[] {
    if (uses === 0) return [];
    return [{ severity: 'success', category: 'cooldown_usage', cd_name: name,
      message: `${name} - ${uses}/${expected} uses.`, occurrences: [] }];
  }

  private unbenchedFindings(name: string, uses: number): AnalysisFinding[] {
    if (uses === 0) return [];
    return [{ severity: 'success', category: 'cooldown_usage', cd_name: name,
      message: `${name} was used ${uses} times. No top-parse data to compare against.`, occurrences: [] }];
  }

  protected analyzeOneDefensive(
    defensive: PlayerDefensive,
    defBench: PerDefensiveBenchmark | undefined,
    fightDurS: number,
  ): AnalysisFinding[] {
    const { name, uses } = defensive;

    if (defensive.talent_gated && uses === 0) return [];

    if (!defBench) return this.unbenchedFindings(name, uses);

    const { expected, floor } = benchExpectedUses(fightDurS, defBench.uses_per_min);
    const castTimesS = defensive.cast_times_s ?? [];

    const issues: AnalysisFinding[] = [];
    if (this.castCadence.usedByMajority(defBench)) {
      const lost = this.castCadence.checkLostUses(DEFENSIVE_VOICE, name, uses, expected, floor, fightDurS);
      if (lost) issues.push(lost);
      const lateFirst = this.castCadence.checkFirstCastDelay(DEFENSIVE_VOICE, name, castTimesS, defBench);
      if (lateFirst) issues.push(lateFirst);
    }
    issues.push(...this.castCadence.checkGaps(DEFENSIVE_VOICE, name, castTimesS, defBench));

    const result = issues.length ? issues : this.usageSuccessFindings(name, uses, expected);
    if (uses > 0) result.push(...this.holdTargets.holdSuggestionFindings(name, castTimesS, defBench.hold_targets));
    return result;
  }

  protected analyzeDefensiveFindings(
    playerDefensives: PlayerDefensive[],
    perDefBench: Record<string, PerDefensiveBenchmark>,
    fightDurS: number,
  ): AnalysisFinding[] {
    const findings: AnalysisFinding[] = [];
    for (const defensive of playerDefensives) {
      findings.push(...this.analyzeOneDefensive(defensive, perDefBench[defensive.name], fightDurS));
    }
    sortBySeverity(findings);
    return findings;
  }

  protected computePlayerDefensiveWindows(topDefWindows: BurstWindow[], dtEvents: TimedEvent[]): PlayerBurstWindow[] {
    return this.windowView.playerWindowDamage(topDefWindows, dtEvents, { maxAbilities: TOP_DAMAGE_SOURCES });
  }

  protected playerCoveredWindow(
    window: BurstWindow, playerDefensive: PlayerDefensive | undefined,
  ): boolean {
    if (!playerDefensive) return false;
    const lo = window.time_s - WINDOW_NEAR_S;
    const hi = window.time_s + window.window_length_s + WINDOW_NEAR_S;
    return playerDefensive.windows.some(span => span.start_s <= hi && span.end_s >= lo);
  }

  // Status is driven by damage TAKEN vs the band (less is better); coverage only annotates, never gates.
  protected defensiveWindowStatus(
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

  protected defensiveMapAnchor(window: BurstWindow): DefensiveMapAnchor {
    return {
      timeS: window.time_s,
      refGameId: window.ref_game_id ?? null,
      windowLengthS: window.window_length_s,
    };
  }

  protected defensiveClipAnchor(window: BurstWindow, index: number): ClipAnchor {
    return { timeS: window.time_s, windowLengthS: window.window_length_s, key: `defensive-${index}` };
  }

  /** Point anchor keyed by the exact cast second, so two findings in one second stay distinct. */
  defensiveFindingClipAnchor(timestampS: number): ClipAnchor {
    return { timeS: timestampS, windowLengthS: 0, key: `defensive-find-${timestampS}` };
  }

  private defensiveAdapter(playerDefensives: PlayerDefensive[]): WindowViewAdapter<DefensiveMapAnchor> {
    const coveredBy = (window: BurstWindow): boolean =>
      this.playerCoveredWindow(window, playerDefensives.find(entry => entry.name === (window.defensive_name ?? '')));
    return {
      status: (window, playerDamage, notReached) =>
        this.defensiveWindowStatus(playerDamage, window.dmg_max, window.dmg_stddev, notReached, coveredBy(window)),
      chips: window => ({
        spellIds: window.spell_id != null ? [window.spell_id] : [],
        labels: window.spell_id == null && window.defensive_name ? [window.defensive_name] : [],
      }),
      mapAnchor: window => this.defensiveMapAnchor(window),
      clipAnchor: (window, index) => this.defensiveClipAnchor(window, index),
    };
  }

  protected buildDefensiveWindows(
    { topWindows, playerWindows, playerDefensives, fightDurationS, abilities }: DefensiveWindowsInput,
  ): WindowView<DefensiveMapAnchor> {
    return this.windowView.buildWindowView({
      topWindows, playerWindows, fightDurationS, abilities, adapter: this.defensiveAdapter(playerDefensives),
    });
  }

  private defensivePlanRow(
    defensive: DefensivePlanMeta,
    benchmark: PerDefensiveBenchmark | undefined,
    windowsS: number[],
    abilities: AbilityIcons,
  ): DefensivePlanRow {
    const spellId = defensive.spell_id;
    const ability = abilities[spellId];
    if (!ability) this.logger.logWarn('buildDefensivePlanRows: ability id missing from ability map', spellId);
    return {
      name: defensive.name,
      spellId,
      icon: ability?.icon ?? '',
      ...this.castCadence.cadencePlanUsage(benchmark),
      windowsS,
      holds: this.castCadence.holdsOf(benchmark),
      rule: defensive.usage_rule ?? null,
    };
  }

  protected buildDefensivePlanRows(bench: DefensiveBench | null): DefensivePlanRow[] {
    if (!bench?.defensives.length) return [];
    const windows = bench.defensive_windows;
    return bench.defensives.map(defensive => this.defensivePlanRow(
      defensive,
      bench.per_defensive_benchmarks[defensive.name],
      windows.filter(window => window.defensive_name === defensive.name).map(window => window.time_s).sort((a, b) => a - b),
      bench.ability_icons,
    )).filter(row => row.typicalUses != null || row.firstCastS != null || row.windowsS.length || row.holds.length || row.rule);
  }
}
