/** Generic, cross-slice WCL-response projections and window view-row builders, kept here so each slice imports one implementation. No Angular / IO. */
import * as z from '../../core/zod-mini';
import { logWarn } from '../../core/log';
import { parseJson } from '../../core/json';
import { ParseRanking, WclEvent, WclRankingsBlob, WclRawAbility, WclRawRanking, WclReport } from '../../core/models/wcl.models';
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

// A per-field fallback keeps a row carrying one unreadable value usable instead of voiding the whole ranking list.
const OPTIONAL_STRING = z.catch(z.optional(z.string()), undefined);

const RAW_RANKING_SCHEMA = z.looseObject({
  name: OPTIONAL_STRING,
  server: z.catch(z.optional(z.looseObject({ name: OPTIONAL_STRING })), undefined),
  report: z.catch(z.optional(z.looseObject({
    code: OPTIONAL_STRING,
    fightID: z.catch(z.optional(z.number()), undefined),
  })), undefined),
});

const RANKINGS_BLOB_SCHEMA = z.looseObject({ rankings: z.optional(z.array(RAW_RANKING_SCHEMA)) });

/** Unwrap WCL's `characterRankings` envelope (string or already-parsed) into its ranking rows; never throws, always returns an array. */
export function unwrapRankings(blob: WclRankingsBlob | null | undefined): WclRawRanking[] {
  if (!blob) return [];
  const parsed = typeof blob === 'string'
    ? parseJson(RANKINGS_BLOB_SCHEMA, blob, 'unwrapRankings: malformed rankings blob')
    : blob;
  return parsed?.rankings ?? [];
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
      server: ranking.server?.name ?? '',
      report_code: ranking.report?.code ?? '',
      fight_id: ranking.report?.fightID ?? 0,
    }));
}

export type ReportActor = NonNullable<WclReport['masterData']>['actors'][number];

// A rankings row spells a realm "Twisting Nether" where a report actor spells it "Twisting-Nether", so identity is the alphanumerics.
function realmKey(server: string): string {
  return server.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Binds a ranking to the actor it names; same-named raiders the realm cannot separate yield null, so no parse is bound to a coin-flip actor. */
export function findParseActor(actors: ReportActor[] | undefined, ranking: ParseRanking): ReportActor | null {
  const named = (actors ?? []).filter(actor => actor.name === ranking.player);
  if (named.length < 2) return named[0] ?? null;
  const rankedRealm = realmKey(ranking.server);
  const [onlyOnRealm, ambiguous] = rankedRealm ? named.filter(actor => realmKey(actor.server) === rankedRealm) : [];
  return onlyOnRealm !== undefined && ambiguous === undefined ? onlyOnRealm : null;
}

/** WCL can leave an ability unnamed and a bench can miss the id outright; both render as a labelled placeholder, and only the missing id is worth a warning. */
export function resolveAbility(
  abilities: Record<number, { icon: string; name: string }>, id: number, source: string,
): { icon: string; name: string } {
  const ability = abilities[id];
  if (!ability) logWarn(`${source}: ability id missing from ability map`, id);
  return { icon: ability?.icon ?? '', name: ability?.name ?? `Ability #${id}` };
}

/** Header chips for a window: each spell id with its baked icon + name. */
export function windowSpells(
  spellIds: number[], abilities: Record<number, { icon: string; name: string }>,
): WindowSpell[] {
  return spellIds.map(id => ({ id, ...resolveAbility(abilities, id, 'windowSpells') }));
}
