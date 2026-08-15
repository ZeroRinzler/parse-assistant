import { Injectable, inject } from '@angular/core';
import { WclApiService } from '../../../core/services/wcl-api';
import { BurstWindow, PlayerBurstWindow } from '../../../core/models/analysis.models';
import { WclEvent } from '../../../core/models/wcl.models';
import { ComparisonWindow, WindowStatus, RangeRow } from '../../../core/models/window-comparison.models';
import { ClipAnchor } from '../../../core/models/capture.models';
import { logWarn } from '../../../core/log';
import { Result, ok } from '../../../core/result';
import { toLoadError } from '../../../core/http-load-error';
import { TimedEvent, normalizeAbilityId, relativeS, windowSpells, withRelativeS } from '../../../shared/analysis/wcl-projections';
import { BURST_DATA_SOURCE } from './burst-data-source';

export type AbilityIcons = Record<number, { icon: string; name: string }>;

export interface BurstMapAnchor {
  timeS: number;
  windowLengthS: number;
}

export interface BurstView {
  windows: ComparisonWindow[];
  anchors: BurstMapAnchor[];
  clipAnchors: ClipAnchor[];
}

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

export function burstDetailRows(
  abilityBreakdown: BurstWindow['ability_breakdown'],
  playerWindow: PlayerBurstWindow | null,
  abilities: AbilityIcons,
): RangeRow[] {
  const playerByAbility: Record<number, { damage: number; casts?: number }> = {};
  for (const ability of playerWindow?.ability_breakdown ?? []) playerByAbility[ability.spell_id] = ability;
  return abilityBreakdown.map(ability => {
    const baked = abilities[ability.spell_id];
    if (!baked) logWarn('burstDetailRows: ability id missing from ability map', ability.spell_id);
    return {
      spellId: ability.spell_id,
      label: baked?.name ?? `Ability #${ability.spell_id}`,
      icon: baked?.icon ?? '',
      playerPct: playerByAbility[ability.spell_id]?.damage ?? null,
      topAvg: ability.avg_damage,
      topMin: ability.min_damage,
      topMax: ability.max_damage,
      playerCasts: playerByAbility[ability.spell_id]?.casts ?? null,
      topCasts: ability.avg_casts ?? null,
      passive: ability.is_passive ?? false,
    };
  });
}

export function burstMapAnchor(window: BurstWindow): BurstMapAnchor {
  return { timeS: window.time_s, windowLengthS: window.window_length_s };
}

/** The `key` is the stable id clips are memoized under. */
export function burstClipAnchor(window: BurstWindow, index: number): ClipAnchor {
  return { timeS: window.time_s, windowLengthS: window.window_length_s, key: `burst-${index}` };
}

export function buildBurstView(
  topWindows: BurstWindow[],
  playerWindows: PlayerBurstWindow[],
  fightDurationS: number,
  cdSpellIds: Record<string, number>,
  abilities: AbilityIcons,
  benchOnly = false,
): BurstView {
  const windows: ComparisonWindow[] = [];
  const anchors: BurstMapAnchor[] = [];
  const clipAnchors: ClipAnchor[] = [];
  topWindows.forEach((window, index) => {
    const notReached = window.time_s > fightDurationS;
    const playerWindow = notReached ? null : (playerWindows[index] ?? null);
    const playerDamage = playerWindow?.window_damage ?? null;
    const { status, icon } = burstWindowStatus(playerDamage, window.dmg_avg, window.dmg_min, window.dmg_stddev, notReached, benchOnly);
    const { spellIds, labels } = splitCommonCds(window.common_cds, cdSpellIds);
    windows.push({
      timeStartS: window.time_s,
      timeEndS: window.time_s + window.window_length_s,
      spells: windowSpells(spellIds, abilities),
      labels,
      status,
      statusIcon: icon,
      overview: { label: '', icon: '', playerPct: playerDamage, topAvg: window.dmg_avg, topMin: window.dmg_min, topMax: window.dmg_max },
      detailRows: burstDetailRows(window.ability_breakdown, playerWindow, abilities),
    });
    anchors.push(burstMapAnchor(window));
    clipAnchors.push(burstClipAnchor(window, index));
  });
  return { windows, anchors, clipAnchors };
}

function eventDamage(event: WclEvent): number {
  return (event.amount ?? 0) + (event.absorbed ?? 0);
}

// Casts are attributed by ability NAME, not spell id, because a damage event's abilityGameID often differs.
function playerWindowAggregate(
  window: BurstWindow,
  sortedDmg: TimedEvent[],
  casts: TimedEvent[],
  nameOf: (spellId: number) => string,
): PlayerBurstWindow {
  const inWindow = (tsS: number): boolean => tsS >= window.time_s && tsS < window.time_s + window.window_length_s;
  const winEvents = sortedDmg.filter(event => inWindow(event.atS));
  const winTotal = winEvents.reduce((sum, event) => sum + eventDamage(event), 0);
  const byAbility: Record<number, number> = {};
  for (const event of winEvents) {
    if (!event.abilityGameID) continue;
    // Match the bench breakdown's normalized spell_id keys so the detail-row join hits.
    const spellId = normalizeAbilityId(event.abilityGameID);
    byAbility[spellId] = (byAbility[spellId] ?? 0) + eventDamage(event);
  }
  const castsByName = new Map<string, number>();
  for (const event of casts) {
    if (inWindow(event.atS)) {
      const name = nameOf(event.abilityGameID);
      castsByName.set(name, (castsByName.get(name) ?? 0) + 1);
    }
  }
  const ability_breakdown = Object.entries(byAbility)
    .sort((a, b) => b[1] - a[1])
    .map(([sid, dmg]) => {
      const spell_id = parseInt(sid, 10);
      return { spell_id, damage: Math.round(dmg), casts: castsByName.get(nameOf(spell_id)) ?? 0 };
    });
  return { time_s: window.time_s, window_damage: Math.round(winTotal), ability_breakdown };
}

export function findPlayerBurstWindows(
  topWindows: BurstWindow[],
  dmgEvents: TimedEvent[],
  castEvents: TimedEvent[],
  abilityNames: Map<number, string>,
): PlayerBurstWindow[] {
  const nameOf = (spellId: number): string => abilityNames.get(spellId) ?? `Spell ${spellId}`;
  const sortedDmg = dmgEvents
    .filter(event => event.atS >= 0 && eventDamage(event) > 0)
    .sort((a, b) => a.atS - b.atS);
  const casts = castEvents.filter(event => event.type === 'cast' && event.abilityGameID);
  return topWindows.map(window => playerWindowAggregate(window, sortedDmg, casts, nameOf));
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
