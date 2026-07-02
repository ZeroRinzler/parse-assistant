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
import { ParseRanking, WclRawRanking } from '../../core/models/wcl.models';
import { WindowSpell } from '../../core/models/window-comparison.models';

// WCL anonymizes a privacy-protected parse's player name to "Character <id>-<id>",
// which can never match a report actor (real names are letters only), so the parse
// is unfetchable. Drop these before mapping.
const ANONYMIZED_NAME = /^Character \d+-\d+$/;

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
