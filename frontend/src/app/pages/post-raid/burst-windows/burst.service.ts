import { Injectable, inject } from '@angular/core';
import { WclApiService } from '../../../core/services/wcl-api';
import { BurstWindow, PlayerBurstWindow } from '../../../core/models/analysis.models';
import { WindowStatus } from '../../../core/models/window-comparison.models';
import { ClipAnchor } from '../../../core/models/capture.models';
import { logWarn } from '../../../core/log';
import { Result, ok } from '../../../core/result';
import { toLoadError } from '../../../core/transport/http-load-error';
import { AbilityIcons, TimedEvent, relativeS, withRelativeS } from '../../../shared/analysis/wcl-projections';
import { WindowView, WindowViewAdapter, buildWindowView, playerWindowDamage } from '../../../shared/analysis/window-view';
import { BURST_DATA_SOURCE } from './burst-data-source';

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

    try {
      const report = await this.wclApi.getReport(reportCode);
      const fight = report.fights.find(entry => entry.id === fightId);
      // A selected fight may legitimately not be in the report yet during a live sync: not a failure.
      if (!fight) return ok(buildBurstView(bench.value.windows, [], Number.POSITIVE_INFINITY, bench.value.cd_spell_ids, bench.value.ability_icons, true));

      // Names only, to attribute the player's casts by ability name in each window.
      const abilityNames = new Map<number, string>();
      for (const ability of report.masterData?.abilities ?? []) abilityNames.set(ability.gameID, ability.name);

      const [casts, damage] = await Promise.all([
        this.wclApi.getAllEvents(reportCode, fightId, 'Casts', fight.startTime, fight.endTime, playerId),
        this.wclApi.getAllEvents(reportCode, fightId, 'DamageDone', fight.startTime, fight.endTime, playerId),
      ]);
      const playerWindows = findPlayerBurstWindows(
        bench.value.windows, withRelativeS(damage, fight.startTime), withRelativeS(casts, fight.startTime), abilityNames,
      );
      const fightDurationS = relativeS(fight.endTime, fight.startTime);
      return ok(buildBurstView(bench.value.windows, playerWindows, fightDurationS, bench.value.cd_spell_ids, bench.value.ability_icons));
    } catch (cause) {
      logWarn(`BurstFeatureService.loadPlayerView ${reportCode}:${fightId}`, cause);
      return toLoadError(cause, 'burst.player-view');
    }
  }

  async loadBenchView(spec: string, encounterId: number): Promise<Result<BurstView>> {
    const bench = await this.source.getBench(spec, encounterId);
    if (!bench.ok) return bench;
    return ok(buildBurstView(bench.value.windows, [], Number.POSITIVE_INFINITY, bench.value.cd_spell_ids, bench.value.ability_icons, true));
  }
}
