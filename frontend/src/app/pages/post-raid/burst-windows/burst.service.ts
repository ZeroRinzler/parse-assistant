/**
 * Burst slice runtime shell + its pure transform functions, colocated.
 *
 * `BurstFeatureService` is the imperative shell (the component injects only it): it
 * reads the prepared bench via the swappable `BURST_DATA_SOURCE`, then calls the
 * pure functions below to assemble the view-model. Every calculated field is its
 * own small, exported, individually-tested pure function - no separate vm file.
 */
import { Injectable, inject } from '@angular/core';
import { WclApiService } from '../../../core/services/wcl-api';
import { BurstWindow, PlayerBurstWindow } from '../../../core/models/analysis.models';
import { WclEvent } from '../../../core/models/wcl.models';
import { ComparisonWindow, WindowStatus, RangeRow, WindowSpell } from '../../../core/models/window-comparison.models';
import { logWarn } from '../../../core/log';
import { BURST_DATA_SOURCE } from './burst-data-source';

/** Spell id -> baked icon + name, complete over every spell the card renders. */
export type AbilityIcons = Record<number, { icon: string; name: string }>;

/** Anchor for opening the positioning map on a burst window (emitted as an output). */
export interface BurstMapAnchor {
  timeS: number;
  label: string;
  spells: WindowSpell[];
}

/** The burst card view-model: one ComparisonWindow + one map anchor per top window. */
export interface BurstView {
  windows: ComparisonWindow[];
  anchors: BurstMapAnchor[];
}

/* ----------------------------- pure functions ----------------------------- */

/**
 * Status glyph for one burst window. Higher player damage is better, so falling
 * short of the top-parse range is the problem.
 */
export function burstWindowStatus(
  playerDamage: number | null,
  topAvg: number,
  topMin: number,
  stddev: number,
  notReached: boolean,
  benchOnly = false,
): { status: WindowStatus; icon: string } {
  // Bench-only (pre-fight): no player log to compare, so the window is purely
  // informational - a neutral chart glyph, never a red "missing data" state.
  if (benchOnly) return { status: 'info', icon: 'insights' };
  if (notReached) return { status: 'muted', icon: 'schedule' };
  if (playerDamage === null) return { status: 'muted', icon: 'help_outline' };
  if (playerDamage < topMin - stddev) return { status: 'bad', icon: 'error' };
  if (topAvg > 0 && playerDamage < topAvg - stddev) return { status: 'warn', icon: 'warning_amber' };
  return { status: 'good', icon: 'check_circle' };
}

/** Split a window's cooldown names into icon spell-ids (known) and plain labels (unknown). */
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

/** Per-ability comparison rows: player damage / casts vs the top-parse range. */
export function burstDetailRows(
  abilityBreakdown: BurstWindow['ability_breakdown'],
  playerWindow: PlayerBurstWindow | null,
  abilities: AbilityIcons,
): RangeRow[] {
  const playerByAbility: Record<number, { damage: number; casts?: number }> = {};
  for (const ability of playerWindow?.ability_breakdown ?? []) playerByAbility[ability.spell_id] = ability;
  return abilityBreakdown.map(ability => ({
    spellId: ability.spell_id,
    label: abilities[ability.spell_id].name,
    icon: abilities[ability.spell_id].icon,
    playerPct: playerByAbility[ability.spell_id]?.damage ?? null,
    topAvg: ability.avg_damage,
    topMin: ability.min_damage,
    topMax: ability.max_damage,
    playerCasts: playerByAbility[ability.spell_id]?.casts ?? null,
    topCasts: ability.avg_casts ?? null,
  }));
}

/** Header chips for a window: each known cooldown with its baked icon + name. */
function windowSpells(spellIds: number[], abilities: AbilityIcons): WindowSpell[] {
  return spellIds.map(id => ({ id, icon: abilities[id].icon, name: abilities[id].name }));
}

/** Map anchor for a window: when to seek and which cooldowns to highlight. */
export function burstMapAnchor(window: BurstWindow, cdSpellIds: Record<string, number>, abilities: AbilityIcons): BurstMapAnchor {
  const cds = window.common_cds ?? [];
  const spellIds = cds.map(name => cdSpellIds[name]).filter((id): id is number => !!id);
  return {
    timeS: window.time_s,
    label: cds.join(', ') || 'Burst window',
    spells: windowSpells(spellIds, abilities),
  };
}

/**
 * Build the burst card view-model: each top-parse burst window paired with the
 * player's damage inside it (by index), plus a map anchor. A window whose start is
 * past the player's fight length is "not reached" and shown muted.
 */
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
  topWindows.forEach((window, index) => {
    const notReached = window.time_s > fightDurationS;
    const playerWindow = notReached ? null : (playerWindows[index] ?? null);
    const playerDamage = playerWindow?.window_damage ?? null;
    const { status, icon } = burstWindowStatus(playerDamage, window.dmg_avg, window.dmg_min, window.dmg_stddev, notReached, benchOnly);
    const { spellIds, labels } = splitCommonCds(window.common_cds ?? [], cdSpellIds);
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
    anchors.push(burstMapAnchor(window, cdSpellIds, abilities));
  });
  return { windows, anchors };
}

/**
 * Player damage dealt inside each top-parse burst window (top 10 abilities, with
 * cast counts). Ported self-contained from the legacy `findPlayerBurstWindows` so
 * the feature service owns the player-side math and never imports `core/analysis`.
 *
 * Window boundary is half-open: an event at exactly `time_s + window_length_s`
 * falls OUTSIDE the window. Cast counts are attributed by ability NAME, not spell
 * id, because a damage event's `abilityGameID` often differs from the cast id.
 */
export function findPlayerBurstWindows(
  topWindows: BurstWindow[],
  dmgEvents: WclEvent[],
  castEvents: WclEvent[],
  fightStartMs: number,
  abilityNames: Map<number, string>,
): PlayerBurstWindow[] {
  const dmgOf = (event: WclEvent): number => (event.amount || 0) + (event.absorbed || 0);
  const nameOf = (spellId: number): string => abilityNames.get(spellId) ?? `Spell ${spellId}`;
  const sorted = dmgEvents
    .filter(event => event.timestamp >= fightStartMs && dmgOf(event) > 0)
    .sort((a, b) => a.timestamp - b.timestamp);
  const casts = castEvents.filter(event => event.type === 'cast' && event.abilityGameID);

  return topWindows.map(window => {
    const inWindow = (tsS: number): boolean => tsS >= window.time_s && tsS < window.time_s + window.window_length_s;
    const winEvents = sorted.filter(event => inWindow((event.timestamp - fightStartMs) / 1000));
    const winTotal = winEvents.reduce((sum, event) => sum + dmgOf(event), 0);
    const byAbility: Record<number, number> = {};
    for (const event of winEvents) {
      if (event.abilityGameID) byAbility[event.abilityGameID] = (byAbility[event.abilityGameID] || 0) + dmgOf(event);
    }
    const castsByName = new Map<string, number>();
    for (const event of casts) {
      if (inWindow((event.timestamp - fightStartMs) / 1000)) {
        const name = nameOf(event.abilityGameID!);
        castsByName.set(name, (castsByName.get(name) ?? 0) + 1);
      }
    }
    const ability_breakdown = Object.entries(byAbility)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([sid, dmg]) => {
        const spell_id = parseInt(sid, 10);
        return { spell_id, damage: Math.round(dmg), casts: castsByName.get(nameOf(spell_id)) ?? 0 };
      });
    return { time_s: window.time_s, window_damage: Math.round(winTotal), ability_breakdown };
  });
}

/* ----------------------------- feature service ---------------------------- */

/**
 * Runtime shell for the burst card. Dual-mode and self-contained: it injects only
 * its data source (file / live by the dev flag) plus the cached `WclApiService`
 * for the player's own log.
 *
 * - Post-raid (`loadPlayerView`): fetches the player's report (master abilities for
 *   icon/name) + Casts/DamageDone, computes the player's window damage with the
 *   colocated `findPlayerBurstWindows`, then compares against the bench windows.
 * - Pre-fight (`loadBenchView`): bench-only, the top windows with no player overlay.
 */
@Injectable({ providedIn: 'root' })
export class BurstFeatureService {
  private readonly source = inject(BURST_DATA_SOURCE);
  private readonly wclApi = inject(WclApiService);

  async loadPlayerView(
    spec: string, encounterId: number, reportCode: string, fightId: number, playerId: number,
  ): Promise<BurstView> {
    const bench = await this.source.getBurstBench(spec, encounterId);
    if (!bench) return { windows: [], anchors: [] };

    try {
      const report = await this.wclApi.getReport(reportCode);
      const fight = report.fights.find(entry => entry.id === fightId);
      if (!fight) return buildBurstView(bench.windows, [], Number.POSITIVE_INFINITY, bench.cd_spell_ids, bench.ability_icons, true);

      // Names only, to attribute the player's casts by ability name in each window.
      const abilityNames = new Map<number, string>();
      for (const ability of report.masterData?.abilities ?? []) abilityNames.set(ability.gameID, ability.name);

      const [casts, damage] = await Promise.all([
        this.wclApi.getAllEvents(reportCode, fightId, 'Casts', fight.startTime, fight.endTime, playerId),
        this.wclApi.getAllEvents(reportCode, fightId, 'DamageDone', fight.startTime, fight.endTime, playerId),
      ]);
      const playerWindows = findPlayerBurstWindows(bench.windows, damage, casts, fight.startTime, abilityNames);
      const fightDurationS = (fight.endTime - fight.startTime) / 1000;
      return buildBurstView(bench.windows, playerWindows, fightDurationS, bench.cd_spell_ids, bench.ability_icons);
    } catch (err) {
      logWarn(`BurstFeatureService.loadPlayerView ${reportCode}:${fightId}`, err);
      return buildBurstView(bench.windows, [], Number.POSITIVE_INFINITY, bench.cd_spell_ids, bench.ability_icons, true);
    }
  }

  /** Pre-fight: the top-parse burst windows with no player overlay (informational). */
  async loadBenchView(spec: string, encounterId: number): Promise<BurstView> {
    const bench = await this.source.getBurstBench(spec, encounterId);
    if (!bench) return { windows: [], anchors: [] };
    return buildBurstView(bench.windows, [], Number.POSITIVE_INFINITY, bench.cd_spell_ids, bench.ability_icons, true);
  }
}
