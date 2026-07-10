/**
 * Generic, cross-slice WCL-response projections and window view-row builders: small pure functions
 * several slices need (raw WCL rankings -> top fetchable parses; spell ids + baked art -> window
 * header chips), kept here so each slice imports one implementation. No Angular / IO.
 */
import { logWarn } from '../../core/log';
import { ParseRanking, WclRankingsBlob, WclRawAbility, WclRawRanking } from '../../core/models/wcl.models';
import { WindowSpell } from '../../core/models/window-comparison.models';

// WCL anonymizes a privacy-protected parse's player name to "Character <id>-<id>",
// which can never match a report actor (real names are letters only), so the parse
// is unfetchable. Drop these before mapping.
const ANONYMIZED_NAME = /^Character \d+-\d+$/;

// WCL reports the physical auto-attack as event ability id 1; the real spell is Auto Attack
// (see the warcraft-wcl-data skill's "Melee auto-attack is event ability id 1" quirk).
export const WCL_MELEE_EVENT_ABILITY_ID = 1;
export const WOW_AUTO_ATTACK_SPELL_ID = 6603;

// Negative ability ids are WCL's unresolvable synthetic sources (pet melee, environmental); 291807
// is the game spell literally named "I Don't Know", a fitting catch-all.
export const WCL_SYNTHETIC_SOURCE_FALLBACK_ID = 291807;

/** Map WCL's synthetic event ability ids to real spells: melee to Auto Attack, negatives to the "I Don't Know" catch-all; real ids pass through. */
export function normalizeAbilityId(id: number): number {
  if (id === WCL_MELEE_EVENT_ABILITY_ID) return WOW_AUTO_ATTACK_SPELL_ID;
  if (id < 0) return WCL_SYNTHETIC_SOURCE_FALLBACK_ID;
  return id;
}

/**
 * Unwrap WCL's `characterRankings` envelope into its ranking rows. WCL returns it
 * either as a JSON blob (string) or an already-parsed object; both forms (and an
 * absent or unparseable blob) are handled, so the result is always an array and the
 * function never throws.
 */
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

/**
 * Project WCL's aliased `gameData.ability` map into an id-keyed `{ icon, name }`
 * record, stripping the trailing `.jpg` so the value is the bare zamimg filename
 * `wl-game-icon` expects. WCL returns `null` for any alias it could not resolve;
 * those are skipped. A resolved entry can still carry a null `icon` (some passives
 * have no art), which projects to an empty string so the icon renders name-only.
 */
export function abilityIcons(
  raw: Record<string, WclRawAbility | null>,
): Record<number, { icon: string; name: string }> {
  const icons: Record<number, { icon: string; name: string }> = {};
  for (const entry of Object.values(raw)) {
    if (entry) icons[entry.id] = { icon: entry.icon?.replace(/\.jpg$/i, '') ?? '', name: entry.name };
  }
  return icons;
}

/** Map raw WCL rankings to the top `count` fetchable parses (report + fight + player). */
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
      // A window can reference an id the ability map never resolved; emit a labelled
      // placeholder with the empty-icon fallback so the card still renders, and warn
      // with the missing id so a bug report can reproduce it.
      logWarn('windowSpells: ability id missing from ability map', id);
      return { id, icon: '', name: `Ability #${id}` };
    }
    return { id, icon: ability.icon, name: ability.name };
  });
}
