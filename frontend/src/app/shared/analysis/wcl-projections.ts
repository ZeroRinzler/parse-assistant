/**
 * Generic, cross-slice WCL-response projections and window view-row builders.
 *
 * These are the small pure functions that several slices projected identically:
 * turning a raw WCL rankings array into the top fetchable parses, and turning a
 * list of spell ids + baked ability art into window header chips. They are not
 * domain analysis - just shape reprojections - so they live here under `shared/`
 * (a blessed cross-slice home, the same way `shared/analysis/analysis-math.ts` and
 * `shared/gear/gear-comparison.ts` do) and each slice imports one implementation
 * instead of re-declaring it. No Angular / `inject()` / IO; pure functions only.
 */
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

/** Map the WCL melee auto-attack event id to the real Auto Attack spell id; other ids pass through. */
export function normalizeAbilityId(id: number): number {
  return id === WCL_MELEE_EVENT_ABILITY_ID ? WOW_AUTO_ATTACK_SPELL_ID : id;
}

/**
 * Unwrap WCL's `characterRankings` envelope into its ranking rows. WCL returns it
 * either as a JSON blob (string) or an already-parsed object; both forms (and an
 * absent blob) are handled, so the result is always an array.
 */
export function unwrapRankings(blob: WclRankingsBlob | null | undefined): WclRawRanking[] {
  if (!blob) return [];
  const parsed = typeof blob === 'string' ? JSON.parse(blob) as { rankings?: WclRawRanking[] } : blob;
  return parsed.rankings ?? [];
}

/**
 * Project WCL's aliased `gameData.ability` map into an id-keyed `{ icon, name }`
 * record, stripping the trailing `.jpg` so the value is the bare zamimg filename
 * `wl-game-icon` expects. WCL returns `null` for any alias it could not resolve;
 * those are skipped.
 */
export function abilityIcons(
  raw: Record<string, WclRawAbility | null>,
): Record<number, { icon: string; name: string }> {
  const icons: Record<number, { icon: string; name: string }> = {};
  for (const entry of Object.values(raw)) {
    if (entry) icons[entry.id] = { icon: entry.icon.replace(/\.jpg$/i, ''), name: entry.name };
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
  return spellIds.map(id => ({ id, icon: abilities[id].icon, name: abilities[id].name }));
}
