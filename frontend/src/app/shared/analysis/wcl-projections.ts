/** Generic, cross-slice WCL-response projections and window view-row builders, kept here so each slice imports one implementation. No Angular / IO. */
import { logWarn } from '../../core/log';
import { ParseRanking, WclEvent, WclRankingsBlob, WclRawAbility, WclRawRanking } from '../../core/models/wcl.models';
import { WindowSpell } from '../../core/models/window-comparison.models';

/** Copies of one NPC share a targetID, so identity needs the instance too; an event naming no target folds into a single bucket. */
export function targetKey(event: WclEvent): string {
  return `${event.targetID ?? 0}:${event.targetInstance ?? 0}`;
}

export function relativeS(laterMs: number, earlierMs: number): number {
  return (laterMs - earlierMs) / 1000;
}

export type TimedEvent = WclEvent & { atS: number };

/** Stamps a WCL event stream with `atS` in one pass, so nothing past this point needs `fightStartMs` again. */
export function withRelativeS(events: WclEvent[], fightStartMs: number): TimedEvent[] {
  return events.map(event => ({ ...event, atS: relativeS(event.timestamp, fightStartMs) }));
}

// WCL anonymizes a privacy-protected parse's player name to "Character <id>-<id>", unfetchable since it can never match a report actor.
const ANONYMIZED_NAME = /^Character \d+-\d+$/;

// WCL reports the physical auto-attack as event ability id 1; the real spell is Auto Attack.
export const WCL_MELEE_EVENT_ABILITY_ID = 1;
export const WOW_AUTO_ATTACK_SPELL_ID = 6603;

// Negative ability ids are WCL's unresolvable synthetic sources (pet melee, environmental); 291807 is the spell "I Don't Know", used as the catch-all.
export const WCL_SYNTHETIC_SOURCE_FALLBACK_ID = 291807;

export function normalizeAbilityId(id: number): number {
  if (id === WCL_MELEE_EVENT_ABILITY_ID) return WOW_AUTO_ATTACK_SPELL_ID;
  if (id < 0) return WCL_SYNTHETIC_SOURCE_FALLBACK_ID;
  return id;
}

/** Unwrap WCL's `characterRankings` envelope (string or already-parsed) into its ranking rows; never throws, always returns an array. */
export function unwrapRankings(blob: WclRankingsBlob | null | undefined): WclRawRanking[] {
  if (!blob) return [];
  const parsed = typeof blob === 'string' ? safeParseRankings(blob) : blob;
  return parsed?.rankings ?? [];
}

/** Parse a rankings envelope string, warning and returning null on a malformed blob. */
function safeParseRankings(raw: string): { rankings?: WclRawRanking[] } | null {
  try {
    return JSON.parse(raw) as { rankings?: WclRawRanking[] };
  } catch (err) {
    logWarn('unwrapRankings: malformed rankings blob', err);
    return null;
  }
}

/** Projects WCL's aliased ability map into an id-keyed `{ icon, name }` record, stripping `.jpg` for the bare filename `wl-game-icon` expects; a null icon becomes '' for name-only render. */
export function abilityIcons(
  raw: Record<string, WclRawAbility | null>,
): Record<number, { icon: string; name: string }> {
  const icons: Record<number, { icon: string; name: string }> = {};
  for (const entry of Object.values(raw)) {
    if (entry) icons[entry.id] = { icon: entry.icon?.replace(/\.jpg$/i, '') ?? '', name: entry.name };
  }
  return icons;
}

export function toParseRankings(raw: WclRawRanking[], count: number): ParseRanking[] {
  return raw
    .filter(ranking => ranking.report?.code && !ANONYMIZED_NAME.test(ranking.name ?? ''))
    .slice(0, count)
    .map(ranking => ({
      player: ranking.name ?? '',
      report_code: ranking.report?.code ?? '',
      fight_id: ranking.report?.fightID ?? 0,
    }));
}

/** Header chips for a window: each spell id with its baked icon + name. */
export function windowSpells(
  spellIds: number[], abilities: Record<number, { icon: string; name: string }>,
): WindowSpell[] {
  return spellIds.map(id => {
    const ability = abilities[id];
    if (!ability) {
      // A window can reference an id the ability map never resolved; emit a labelled placeholder and warn so a bug report can reproduce it.
      logWarn('windowSpells: ability id missing from ability map', id);
      return { id, icon: '', name: `Ability #${id}` };
    }
    return { id, icon: ability.icon, name: ability.name };
  });
}
