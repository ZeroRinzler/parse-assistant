import { Injectable, inject } from '@angular/core';
import { WclApiService } from '../../../../core/wcl/wcl-api-service';
import { BurstWindow, PlayerBurstWindow } from '../../../../domain/analysis/analysis.models';
import { WindowStatus } from '../../../../domain/analysis/window-comparison.models';
import { ClipAnchor } from '../../../../domain/capture/capture.models';
import { Result, Results } from '../../../../core/http/result';
import { WclProjectionsService, AbilityIcons, TimedEvent } from '../../../../domain/analysis/wcl-projections-service';
import { WindowView, WindowViewAdapter } from '../../../../domain/analysis/window-view-service';
import { PullContextService, PullContext, PullRef } from '../../../../domain/analysis/pull-context-service';
import { BURST_DATA_SOURCE, BurstBench } from '../data-access/burst-data-source';
import { WindowViewService } from '../../../../domain/analysis/window-view-service';

export interface BurstMapAnchor {
  timeS: number;
  windowLengthS: number;
}

export type BurstView = WindowView<BurstMapAnchor>;

@Injectable({ providedIn: 'root' })
export class BurstFeatureService {
  private readonly windowView = inject(WindowViewService);
  private readonly pullContext = inject(PullContextService);
  private readonly wclProjections = inject(WclProjectionsService);
  private readonly source = inject(BURST_DATA_SOURCE);
  private readonly wclApi = inject(WclApiService);

  async loadPlayerView(
    spec: string, encounterId: number, reportCode: string, fightId: number, playerId: number,
  ): Promise<Result<BurstView>> {
    const bench = await this.source.getBench(spec, encounterId);
    if (!bench.ok) return bench;

    const pull: PullRef = { reportCode, fightId };
    return this.pullContext.analyzePull(this.wclApi, pull, {
      logSource: 'BurstFeatureService.loadPlayerView',
      errorId: 'burst.player-view',
      emptyView: () => this.benchOnlyView(bench.value),
      analyze: context => this.playerView(bench.value, pull, playerId, context),
    });
  }

  private async playerView(
    bench: BurstBench, pull: PullRef, playerId: number, context: PullContext,
  ): Promise<BurstView> {
    const { reportCode, fightId } = pull;
    const { report, fight, fightDurationS } = context;
    // Names only, to attribute the player's casts by ability name in each window.
    const abilityNames = new Map<number, string>();
    for (const ability of report.masterData?.abilities ?? []) abilityNames.set(ability.gameID, ability.name);

    const [casts, damage] = await Promise.all([
      this.wclApi.getAllEvents(reportCode, fightId, 'Casts', fight.startTime, fight.endTime, playerId),
      this.wclApi.getAllEvents(reportCode, fightId, 'DamageDone', fight.startTime, fight.endTime, playerId),
    ]);
    const playerWindows = this.findPlayerBurstWindows(
      bench.windows, this.wclProjections.withRelativeS(damage, fight.startTime), this.wclProjections.withRelativeS(casts, fight.startTime), abilityNames,
    );
    return this.buildBurstView(bench.windows, playerWindows, fightDurationS, bench.cd_spell_ids, bench.ability_icons);
  }

  async loadBenchView(spec: string, encounterId: number): Promise<Result<BurstView>> {
    const bench = await this.source.getBench(spec, encounterId);
    if (!bench.ok) return bench;
    return Results.ok(this.benchOnlyView(bench.value));
  }

  /** Higher player damage is better, so falling short of the top-parse range is the problem. */
  protected burstWindowStatus(
    playerDamage: number | null,
    topAvg: number,
    topMin: number,
    stddev: number,
    notReached: boolean,
    benchOnly = false,
  ): { status: WindowStatus; icon: string } {
    // Pre-fight has no player log to compare, so the window is purely informational.
    if (benchOnly) return { status: 'info', icon: 'insights' };
    if (notReached) return { status: 'muted', icon: 'schedule' };
    if (playerDamage === null) return { status: 'muted', icon: 'help_outline' };
    if (playerDamage < topMin - stddev) return { status: 'bad', icon: 'error' };
    if (topAvg > 0 && playerDamage < topAvg - stddev) return { status: 'warn', icon: 'warning_amber' };
    return { status: 'good', icon: 'check_circle' };
  }

  protected splitCommonCds(
    commonCds: string[],
    cdSpellIds: Record<string, number>,
  ): { spellIds: number[]; labels: string[] } {
    const spellIds: number[] = [];
    const labels: string[] = [];
    for (const name of commonCds) {
      const spellId = cdSpellIds[name];
      if (spellId) spellIds.push(spellId);
      else labels.push(name);
    }
    return { spellIds, labels };
  }

  protected burstMapAnchor(window: BurstWindow): BurstMapAnchor {
    return { timeS: window.time_s, windowLengthS: window.window_length_s };
  }

  /** The `key` is the stable id clips are memoized under. */
  protected burstClipAnchor(window: BurstWindow, index: number): ClipAnchor {
    return { timeS: window.time_s, windowLengthS: window.window_length_s, key: `burst-${index}` };
  }

  private burstAdapter(cdSpellIds: Record<string, number>, benchOnly: boolean): WindowViewAdapter<BurstMapAnchor> {
    return {
      status: (window, playerDamage, notReached) =>
        this.burstWindowStatus(playerDamage, window.dmg_avg, window.dmg_min, window.dmg_stddev, notReached, benchOnly),
      chips: window => this.splitCommonCds(window.common_cds, cdSpellIds),
      mapAnchor: window => this.burstMapAnchor(window),
      clipAnchor: (window, index) => this.burstClipAnchor(window, index),
      castColumns: true,
    };
  }

  protected buildBurstView(
    topWindows: BurstWindow[],
    playerWindows: PlayerBurstWindow[],
    fightDurationS: number,
    cdSpellIds: Record<string, number>,
    abilities: AbilityIcons,
    benchOnly = false,
  ): BurstView {
    return this.windowView.buildWindowView({
      topWindows, playerWindows, fightDurationS, abilities, adapter: this.burstAdapter(cdSpellIds, benchOnly),
    });
  }

  private benchOnlyView(bench: BurstBench): BurstView {
    return this.buildBurstView(bench.windows, [], Number.POSITIVE_INFINITY, bench.cd_spell_ids, bench.ability_icons, true);
  }

  protected findPlayerBurstWindows(
    topWindows: BurstWindow[],
    dmgEvents: TimedEvent[],
    castEvents: TimedEvent[],
    abilityNames: Map<number, string>,
  ): PlayerBurstWindow[] {
    const nameOf = (spellId: number): string => abilityNames.get(spellId) ?? `Spell ${spellId}`;
    return this.windowView.playerWindowDamage(topWindows, dmgEvents, { attribution: { casts: castEvents, nameOf } });
  }
}
