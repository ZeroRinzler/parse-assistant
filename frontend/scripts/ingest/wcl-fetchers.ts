/**
 * Extract layer - high-level `get*` fetchers.
 *
 * Each function composes the transport client (wcl-client), a query string
 * (wcl-queries), and a pure mapper (wcl-mappers) into a single WCL operation.
 * They accept a `WclQueryClient` interface rather than the concrete class so tests
 * can inject a fake. Best-effort failures are logged via `logWarn`, never silently
 * swallowed.
 */

import { logWarn } from '../../src/app/core/log.ts';
import type { WclQueryClient } from './wcl-client.ts';
import {
  ENCOUNTERS_QUERY, RANKINGS_QUERY, REPORT_META_QUERY, buildEnchantQuery,
  type RankingsQueryVars, type ReportMetaQueryVars,
} from './wcl-queries.ts';
import {
  SPEC_TO_WCL, mapRankings, filterEncounters, extractGear, parseEnchantResults,
} from './wcl-mappers.ts';
import { pickBossActorId } from './analysis/positions.ts';
import type {
  WclExpansion, WclRawRanking, WclFightEntry, WclActorEntry, WclResourceEvent,
  WclCombatantInfoEvent, ParseRanking, EnrichedRanking, IngestEncounter, ParseEventBundle,
} from './models/wcl.models.ts';

/** Current-expansion encounters (1 query). */
export async function getEncounters(client: WclQueryClient): Promise<IngestEncounter[]> {
  const data = await client.query<{ worldData: { expansions: WclExpansion[] } }>(ENCOUNTERS_QUERY);
  return filterEncounters(data.worldData.expansions);
}

// Cheap rankings fetch: tries partitions newest-first, falling back to null
// (current) when a zone has none. Server slug resolution is deferred to
// enrichRanking; talent key comes from the parse's CombatantInfo.
export async function getRankingsLite(
  client: WclQueryClient, spec: string, encounterId: number, count = 10, partitionIds: number[] = [],
): Promise<ParseRanking[]> {
  const mapping = SPEC_TO_WCL[spec];
  if (!mapping) throw new Error(`Unknown spec: ${spec}`);
  const [className, specName] = mapping;

  const attempts: Array<number | null> = partitionIds.length > 0 ? partitionIds : [null];
  for (const partition of attempts) {
    const variables: RankingsQueryVars = { encounterID: encounterId, className, specName };
    if (partition != null) variables.partition = partition;
    const data = await client.query<{ worldData: { encounter: { name: string; characterRankings: string | { rankings: WclRawRanking[] } } } }, RankingsQueryVars>(RANKINGS_QUERY, variables);
    const rawRankings = data.worldData.encounter.characterRankings;
    const rankingsData = typeof rawRankings === 'string' ? JSON.parse(rawRankings) as { rankings: WclRawRanking[] } : rawRankings;
    const mapped = mapRankings(rankingsData.rankings ?? [], count);
    if (mapped.length > 0) return mapped;
  }
  return [];
}

// Per-player enrichment: resolves server slug (1 query, cached) and extracts gear.
export async function enrichRanking(client: WclQueryClient, ranking: ParseRanking): Promise<EnrichedRanking> {
  const rawRanking = ranking._raw;
  const serverId = rawRanking.server?.id;
  const [serverSlug, serverRegion] = serverId ? await client.resolveServerSlug(serverId) : ['', ''];
  return {
    server_slug: serverSlug,
    server_region: serverRegion,
    combatant_info: { talent_key: '', ...extractGear(rawRanking) },
  };
}

// Fetches every event stream for one parse into a ParseEventBundle for the (pure)
// analyzer. Returns null on the failure paths the ingest loop treats as "skip this
// parse" (missing report/fight, event-fetch error). Throws only when the player is
// genuinely absent from the report (a data integrity error).
export async function getParseEvents(
  client: WclQueryClient, reportCode: string, fightId: number, playerName: string,
): Promise<ParseEventBundle | null> {
  let meta: { reportData: { report: { fights: WclFightEntry[]; masterData: { actors: WclActorEntry[] } } } };
  try {
    meta = await client.query<typeof meta, ReportMetaQueryVars>(REPORT_META_QUERY, { code: reportCode });
  } catch (err) {
    logWarn(`getParseEvents report meta ${reportCode}`, err);
    return null;
  }

  const report = meta.reportData.report;
  const fight = report.fights.find(entry => entry.id === fightId);
  if (!fight) return null;

  const actors = report.masterData.actors;
  const player = actors.find(actor => actor.name === playerName && actor.type === 'Player');
  if (!player) throw new Error(`Player "${playerName}" not found in report ${reportCode} (fight ${fightId}).`);
  // Enemy actor lookup (by actor id) for position timelines, keyed later by gameID.
  const npcById = new Map<number, WclActorEntry>(actors.filter(actor => actor.type !== 'Player').map(actor => [actor.id, actor]));

  const start = fight.startTime;
  const end = fight.endTime;
  const fightDurS = (end - start) / 1000;

  // Fetch all event types in parallel. Positions ride along on the (smaller) Casts
  // streams via includeResources, keeping the dense damage streams plain.
  let castEvents: WclResourceEvent[], buffEvents: WclResourceEvent[], damageEvents: WclResourceEvent[],
    damageTakenEvents: WclResourceEvent[], enemyCastEvents: WclResourceEvent[], combatantEvents: WclCombatantInfoEvent[];
  try {
    const results = await Promise.all([
      client.getAllEvents(reportCode, fightId, 'Casts',         start, end, { sourceId: player.id, includeResources: true }),
      client.getAllEvents(reportCode, fightId, 'Buffs',         start, end, { targetId: player.id }),
      client.getAllEvents(reportCode, fightId, 'DamageDone',    start, end, { sourceId: player.id }),
      client.getAllEvents(reportCode, fightId, 'DamageTaken',   start, end, { sourceId: player.id }),
      client.getAllEvents(reportCode, fightId, 'Casts',         start, end, { includeResources: true, hostilityType: 'Enemies' })
        .catch((err): WclResourceEvent[] => { logWarn(`getParseEvents enemy casts ${reportCode}`, err); return []; }),
      client.getAllEvents(reportCode, fightId, 'CombatantInfo', start, end, { sourceId: player.id })
        .catch((err): WclResourceEvent[] => { logWarn(`getParseEvents combatant info ${reportCode}`, err); return []; }),
    ]);
    castEvents = results[0];
    buffEvents = results[1];
    damageEvents = results[2];
    damageTakenEvents = results[3];
    enemyCastEvents = results[4];
    combatantEvents = results[5] as unknown as WclCombatantInfoEvent[];
  } catch (err) {
    logWarn(`getParseEvents events ${reportCode}`, err);
    return null;
  }

  // Dense boss positions from a single targeted stream (boss auto-attacks),
  // identified as the highest-maxHitPoints enemy in the enemy cast snapshots.
  let bossDamageEvents: WclResourceEvent[] = [];
  const bossActorId = pickBossActorId(enemyCastEvents, npcById);
  if (bossActorId != null) {
    bossDamageEvents = await client
      .getAllEvents(reportCode, fightId, 'DamageDone', start, end, { sourceId: bossActorId, includeResources: true })
      .catch((err): WclResourceEvent[] => { logWarn(`getParseEvents boss damage ${reportCode}`, err); return []; });
  }

  return {
    report_code: reportCode, fight_id: fightId, player, npcById, start, end, fightDurS,
    castEvents, buffEvents, damageEvents, damageTakenEvents, enemyCastEvents, combatantEvents, bossDamageEvents,
  };
}

// Batch-resolve enchant display names via WCL gameData (one aliased round-trip).
// Returns an id->name map of only the ids that resolved to a non-empty name.
export async function getEnchantNames(client: WclQueryClient, ids: Array<number | string>): Promise<Map<number | string, string>> {
  if (!ids.length) return new Map();
  try {
    const result = await client.query<{ gameData: Record<string, { id: number; name: string } | null | undefined> }>(buildEnchantQuery(ids));
    return parseEnchantResults(result.gameData ?? {}, ids);
  } catch (err) {
    logWarn('getEnchantNames', err);
    return new Map();
  }
}
