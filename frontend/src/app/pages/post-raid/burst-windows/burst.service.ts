import { Injectable, inject } from '@angular/core';
import { WclApiService } from '../../../core/services/wcl-api';
import { BurstWindow, PlayerBurstWindow } from '../../../core/models/analysis.models';
import { WindowStatus } from '../../../core/models/window-comparison.models';
import { ClipAnchor } from '../../../core/models/capture.models';
import { Result, ok } from '../../../core/result';
import { AbilityIcons, TimedEvent, withRelativeS } from '../../../shared/analysis/wcl-projections';
import { WindowView, WindowViewAdapter, buildWindowView, playerWindowDamage } from '../../../shared/analysis/window-view';
import { PullContext, PullRef, analyzePull } from '../../../shared/analysis/pull-context';
import { BURST_DATA_SOURCE, BurstBench } from './burst-data-source';

export interface BurstMapAnchor {
  timeS: number;
  windowLengthS: number;
}

export type BurstView = WindowView<BurstMapAnchor>;

/** Higher player damage is better, so falling short of the top-parse range is the problem. */
export function burstWindowStatus(
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

export function splitCommonCds(
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

export function burstMapAnchor(window: BurstWindow): BurstMapAnchor {
  return { timeS: window.time_s, windowLengthS: window.window_length_s };
}

/** The `key` is the stable id clips are memoized under. */
export function burstClipAnchor(window: BurstWindow, index: number): ClipAnchor {
  return { timeS: window.time_s, windowLengthS: window.window_length_s, key: `burst-${index}` };
}

function burstAdapter(cdSpellIds: Record<string, number>, benchOnly: boolean): WindowViewAdapter<BurstMapAnchor> {
  return {
    status: (window, playerDamage, notReached) =>
      burstWindowStatus(playerDamage, window.dmg_avg, window.dmg_min, window.dmg_stddev, notReached, benchOnly),
    chips: window => splitCommonCds(window.common_cds, cdSpellIds),
    mapAnchor: burstMapAnchor,
    clipAnchor: burstClipAnchor,
    castColumns: true,
  };
}

export function buildBurstView(
  topWindows: BurstWindow[],
  playerWindows: PlayerBurstWindow[],
  fightDurationS: number,
  cdSpellIds: Record<string, number>,
  abilities: AbilityIcons,
  benchOnly = false,
): BurstView {
  return buildWindowView({
    topWindows, playerWindows, fightDurationS, abilities, adapter: burstAdapter(cdSpellIds, benchOnly),
  });
}

function benchOnlyView(bench: BurstBench): BurstView {
  return buildBurstView(bench.windows, [], Number.POSITIVE_INFINITY, bench.cd_spell_ids, bench.ability_icons, true);
}

export function findPlayerBurstWindows(
  topWindows: BurstWindow[],
  dmgEvents: TimedEvent[],
  castEvents: TimedEvent[],
  abilityNames: Map<number, string>,
): PlayerBurstWindow[] {
  const nameOf = (spellId: number): string => abilityNames.get(spellId) ?? `Spell ${spellId}`;
  return playerWindowDamage(topWindows, dmgEvents, { attribution: { casts: castEvents, nameOf } });
}

@Injectable({ providedIn: 'root' })
export class BurstFeatureService {
  private readonly source = inject(BURST_DATA_SOURCE);
  private readonly wclApi = inject(WclApiService);

  async loadPlayerView(
    spec: string, encounterId: number, reportCode: string, fightId: number, playerId: number,
  ): Promise<Result<BurstView>> {
    const bench = await this.source.getBench(spec, encounterId);
    if (!bench.ok) return bench;

    const pull: PullRef = { reportCode, fightId };
    return analyzePull(this.wclApi, pull, {
      logSource: 'BurstFeatureService.loadPlayerView',
      errorId: 'burst.player-view',
      emptyView: () => benchOnlyView(bench.value),
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
    const playerWindows = findPlayerBurstWindows(
      bench.windows, withRelativeS(damage, fight.startTime), withRelativeS(casts, fight.startTime), abilityNames,
    );
    return buildBurstView(bench.windows, playerWindows, fightDurationS, bench.cd_spell_ids, bench.ability_icons);
  }

  async loadBenchView(spec: string, encounterId: number): Promise<Result<BurstView>> {
    const bench = await this.source.getBench(spec, encounterId);
    if (!bench.ok) return bench;
    return ok(benchOnlyView(bench.value));
  }
}
