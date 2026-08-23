import { BurstWindow, PlayerBurstWindow } from '../../core/models/analysis.models';
import { ClipAnchor } from '../../core/models/capture.models';
import { ComparisonWindow, RangeRow, WindowStatus } from '../../core/models/window-comparison.models';
import { AbilityIcons, TimedEvent, normalizeAbilityId, resolveAbility, windowSpells } from './wcl-projections';

function eventDamage(event: TimedEvent): number {
  return (event.amount ?? 0) + (event.absorbed ?? 0);
}

/** Casts are attributed by ability NAME, not spell id, because a damage event's abilityGameID often differs from the cast's. */
interface CastAttribution {
  casts: TimedEvent[];
  nameOf: (spellId: number) => string;
}

interface PlayerWindowOptions {
  attribution?: CastAttribution;
  maxAbilities?: number;
}

function castsByName(
  casts: TimedEvent[], inWindow: (tsS: number) => boolean, nameOf: (spellId: number) => string,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const event of casts) {
    if (!inWindow(event.atS)) continue;
    const name = nameOf(event.abilityGameID);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}

function windowBreakdown(
  window: BurstWindow, sortedDamage: TimedEvent[], casts: TimedEvent[], options: PlayerWindowOptions,
): PlayerBurstWindow {
  const inWindow = (tsS: number): boolean => tsS >= window.time_s && tsS < window.time_s + window.window_length_s;
  const winEvents = sortedDamage.filter(event => inWindow(event.atS));
  const winTotal = winEvents.reduce((sum, event) => sum + eventDamage(event), 0);
  const byAbility: Record<number, number> = {};
  for (const event of winEvents) {
    if (!event.abilityGameID) continue;
    // Fold onto the bench breakdown's normalized spell_id keys so the detail-row join hits.
    const spellId = normalizeAbilityId(event.abilityGameID);
    byAbility[spellId] = (byAbility[spellId] ?? 0) + eventDamage(event);
  }
  const attribution = options.attribution;
  const counts = attribution ? castsByName(casts, inWindow, attribution.nameOf) : new Map<string, number>();
  const ranked = Object.entries(byAbility).sort((a, b) => b[1] - a[1]);
  const kept = options.maxAbilities == null ? ranked : ranked.slice(0, options.maxAbilities);
  const ability_breakdown = kept.map(([sid, dmg]) => {
    const spell_id = parseInt(sid, 10);
    const damage = Math.round(dmg);
    return attribution ? { spell_id, damage, casts: counts.get(attribution.nameOf(spell_id)) ?? 0 } : { spell_id, damage };
  });
  return { window_damage: Math.round(winTotal), ability_breakdown };
}

/** `buildWindowView` pairs these by index, so filtering this output shifts every window's damage. */
export function playerWindowDamage(
  topWindows: BurstWindow[],
  damageEvents: TimedEvent[],
  options: PlayerWindowOptions = {},
): PlayerBurstWindow[] {
  const sorted = damageEvents
    .filter(event => event.atS >= 0 && eventDamage(event) > 0)
    .sort((a, b) => a.atS - b.atS);
  const casts = options.attribution?.casts.filter(event => event.type === 'cast' && event.abilityGameID) ?? [];
  return topWindows.map(window => windowBreakdown(window, sorted, casts, options));
}

interface WindowVerdict {
  status: WindowStatus;
  icon: string;
  /** The builder appends this to the chip labels; chips() must not carry it too. */
  note?: string;
}

interface WindowChips {
  spellIds: number[];
  labels: string[];
}

export interface WindowViewAdapter<A> {
  status: (window: BurstWindow, playerDamage: number | null, notReached: boolean) => WindowVerdict;
  chips: (window: BurstWindow) => WindowChips;
  mapAnchor: (window: BurstWindow) => A;
  clipAnchor: (window: BurstWindow, index: number) => ClipAnchor;
  castColumns?: boolean;
}

interface WindowViewInput<A> {
  topWindows: BurstWindow[];
  playerWindows: PlayerBurstWindow[];
  fightDurationS: number;
  abilities: AbilityIcons;
  adapter: WindowViewAdapter<A>;
}

export interface WindowView<A> {
  windows: ComparisonWindow[];
  anchors: A[];
  clipAnchors: ClipAnchor[];
}

function windowDetailRows(
  abilityBreakdown: BurstWindow['ability_breakdown'],
  playerWindow: PlayerBurstWindow | null,
  abilities: AbilityIcons,
  castColumns: boolean,
): RangeRow[] {
  const playerByAbility: Record<number, { damage: number; casts?: number }> = {};
  for (const ability of playerWindow?.ability_breakdown ?? []) playerByAbility[ability.spell_id] = ability;
  return abilityBreakdown.map(ability => {
    const baked = resolveAbility(abilities, ability.spell_id, 'windowDetailRows');
    const player = playerByAbility[ability.spell_id];
    const row: RangeRow = {
      spellId: ability.spell_id,
      label: baked.name,
      icon: baked.icon,
      playerPct: player?.damage ?? null,
      topAvg: ability.avg_damage,
      topMin: ability.min_damage,
      topMax: ability.max_damage,
    };
    if (!castColumns) return row;
    return { ...row, playerCasts: player?.casts ?? null, topCasts: ability.avg_casts ?? null, passive: ability.is_passive ?? false };
  });
}

export function buildWindowView<A>(
  { topWindows, playerWindows, fightDurationS, abilities, adapter }: WindowViewInput<A>,
): WindowView<A> {
  const windows: ComparisonWindow[] = [];
  const anchors: A[] = [];
  const clipAnchors: ClipAnchor[] = [];
  topWindows.forEach((window, index) => {
    const notReached = window.time_s > fightDurationS;
    // playerWindows is the index-aligned aggregation over these same topWindows, so a time-based match would drift.
    const playerWindow = notReached ? null : (playerWindows[index] ?? null);
    const playerDamage = playerWindow?.window_damage ?? null;
    const { status, icon, note } = adapter.status(window, playerDamage, notReached);
    const { spellIds, labels } = adapter.chips(window);
    windows.push({
      timeStartS: window.time_s,
      timeEndS: window.time_s + window.window_length_s,
      spells: windowSpells(spellIds, abilities),
      labels: note ? [...labels, note] : labels,
      status,
      statusIcon: icon,
      overview: { label: '', icon: '', playerPct: playerDamage, topAvg: window.dmg_avg, topMin: window.dmg_min, topMax: window.dmg_max },
      detailRows: windowDetailRows(window.ability_breakdown, playerWindow, abilities, adapter.castColumns ?? false),
    });
    anchors.push(adapter.mapAnchor(window));
    clipAnchors.push(adapter.clipAnchor(window, index));
  });
  return { windows, anchors, clipAnchors };
}
