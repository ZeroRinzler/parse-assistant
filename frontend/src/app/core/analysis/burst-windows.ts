/**
 * Maps the top-parse burst / defensive windows onto the player's own damage
 * (or damage-taken) stream, so the UI can compare the player's output inside
 * each window against the top-parse average.
 *
 * Window boundary is half-open: an event at exactly `time_s + window_length_s`
 * falls OUTSIDE the window.
 */
import { BurstWindow, PlayerBurstWindow } from '../models/analysis.models';
import { WclEvent } from '../models/wcl.models';

const dmgOf = (e: WclEvent) => (e.amount || 0) + (e.absorbed || 0);

/**
 * Sum + top-N ability breakdown of a player's events inside each given window.
 * When `castEvents` is supplied, each ability also carries a `casts` count.
 *
 * Cast counts are attributed by ability NAME, not spell id: a damage-breakdown
 * row is keyed by the damage event's `abilityGameID`, which for many abilities
 * (Shadow Blades 279043 vs cast 121471, Secret Technique 282449 vs cast 280719)
 * differs from the cast event's id. The shared WCL ability name is the only
 * reliable bridge between the two id spaces, so casts are grouped by name and
 * each row reads its name's count.
 */
function windowDamageBreakdown(
  windows: BurstWindow[],
  events: WclEvent[],
  fStart: number,
  topN: number,
  castEvents: WclEvent[] = [],
  abilityNames: Map<number, string> = new Map(),
): PlayerBurstWindow[] {
  const sorted = events
    .filter((e) => e.timestamp >= fStart && dmgOf(e) > 0)
    .sort((a, b) => a.timestamp - b.timestamp);
  const casts = castEvents.filter((e) => e.type === 'cast' && e.abilityGameID);
  const nameOf = (spellId: number) => abilityNames.get(spellId) ?? `Spell ${spellId}`;

  return windows.map((w) => {
    const winLenS = w.window_length_s;
    const inWindow = (tsS: number) => tsS >= w.time_s && tsS < w.time_s + winLenS;
    const winEvents = sorted.filter((e) => inWindow((e.timestamp - fStart) / 1000));
    const winTotal = winEvents.reduce((s, e) => s + dmgOf(e), 0);
    const byAb: Record<number, number> = {};
    for (const e of winEvents) {
      if (e.abilityGameID) byAb[e.abilityGameID] = (byAb[e.abilityGameID] || 0) + dmgOf(e);
    }
    const castsByName = new Map<string, number>();
    for (const e of casts) {
      if (inWindow((e.timestamp - fStart) / 1000)) {
        const name = nameOf(e.abilityGameID!);
        castsByName.set(name, (castsByName.get(name) ?? 0) + 1);
      }
    }
    const ability_breakdown = Object.entries(byAb)
      .sort((a, b) => b[1] - a[1])
      .slice(0, topN)
      .map(([sid, dmg]) => {
        const spell_id = parseInt(sid, 10);
        const entry: { spell_id: number; damage: number; casts?: number } = { spell_id, damage: Math.round(dmg) };
        if (castEvents.length) entry.casts = castsByName.get(nameOf(spell_id)) ?? 0;
        return entry;
      });
    return { time_s: w.time_s, window_damage: Math.round(winTotal), ability_breakdown };
  });
}

/** Player damage dealt inside each top-parse burst window (top 10 abilities, with cast counts). */
export function findPlayerBurstWindows(
  topBurstWindows: BurstWindow[], dmgEvents: WclEvent[], castEvents: WclEvent[], fStart: number,
  abilityNames: Map<number, string>,
): PlayerBurstWindow[] {
  return windowDamageBreakdown(topBurstWindows, dmgEvents, fStart, 10, castEvents, abilityNames);
}

/** Player damage taken inside each top-parse defensive window (top 6 abilities). */
export function computePlayerDefensiveWindows(topDefWindows: BurstWindow[], dtEvents: WclEvent[], fStart: number): PlayerBurstWindow[] {
  return windowDamageBreakdown(topDefWindows, dtEvents, fStart, 6);
}
