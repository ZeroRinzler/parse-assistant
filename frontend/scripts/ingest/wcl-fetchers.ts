/**
 * Extract layer - encounter discovery.
 *
 * The v5 ingestion (orchestrator.ts) drives the Angular `*TransformService`s for all
 * per-parse fetching and analysis; the only `get*` fetcher that survives here is the
 * one piece of orchestration the transforms do not own: resolving which raids are
 * "current" from `worldData` plus a cheap rankings liveness probe. It composes the
 * transport client (wcl-client), the discovery query strings (wcl-queries), and the
 * pure mappers (wcl-mappers), accepting a `WclQueryClient` interface so tests can
 * inject a fake. Best-effort failures are logged via `logWarn`, never swallowed.
 */

import { logWarn } from '../../src/app/core/log.ts';
import { BudgetExceededError, type WclQueryClient } from './wcl-client.ts';
import {
  ENCOUNTERS_QUERY, RANKINGS_QUERY, type RankingsQueryVars,
} from './wcl-queries.ts';
import {
  SPEC_TO_WCL, mapRankings, filterEncounters, groupEncountersByZone, protectedEncounterIds,
} from './wcl-mappers.ts';
import type {
  WclExpansion, WclRawRanking, ParseRanking, IngestEncounter,
} from './models/wcl.models.ts';

// Reliably-populated DPS specs used to probe a zone for liveness. A genuinely live
// raid has many real parses for any of these; a beta/PTR/test zone has none, so one
// representative encounter probed across these specs cleanly separates the two.
const PROBE_SPECS = ['FireMage', 'RetributionPaladin', 'FuryWarrior'];
// Minimum non-anonymous rankings (summed across PROBE_SPECS on the zone's first
// encounter) for a zone to count as live. >=1 is unsafe: a single non-anon parse on a
// test boss would promote it; a real raid clears this easily.
const LIVE_RANKINGS_THRESHOLD = 3;
const PROBE_COUNT = 10;
// Stop probing cleanly when the WCL hourly budget runs low.
const PROBE_BUDGET_MARGIN = 500;

export interface CurrentContent {
  // Live current-expansion raid encounters to ingest (frozen:false, not name-excluded,
  // confirmed live by the rankings probe).
  encounters: IngestEncounter[];
  // All non-frozen current-expansion encounter ids - the prune-protected set.
  protectedIds: Set<number>;
}

// Probe one representative encounter of a zone across PROBE_SPECS; the zone is live if
// the summed non-anonymous ranking count reaches LIVE_RANKINGS_THRESHOLD. BudgetExceeded
// propagates (stop cleanly); other per-spec errors are logged and treated as zero.
async function isZoneLive(client: WclQueryClient, zoneEncounters: IngestEncounter[]): Promise<boolean> {
  const probeEncounter = zoneEncounters[0];
  if (!probeEncounter) return false;
  let realCount = 0;
  for (const probeSpec of PROBE_SPECS) {
    await client.assertBudget(PROBE_BUDGET_MARGIN);
    try {
      const ranked = await getRankingsLite(client, probeSpec, probeEncounter.id, PROBE_COUNT, probeEncounter.partitionIds);
      realCount += ranked.length;
      if (realCount >= LIVE_RANKINGS_THRESHOLD) return true;
    } catch (err) {
      if (err instanceof BudgetExceededError) throw err;
      logWarn(`getEncounters probe ${probeEncounter.name} (${probeSpec})`, err);
    }
  }
  return false;
}

// Resolve which raids are "current" entirely from WCL (1 worldData query + a cheap
// per-candidate-zone rankings probe). Returns the live encounters to ingest plus the
// prune-protected id set. The probe runs once here, not per spec, so beta/PTR/test
// zones cost a handful of queries total instead of one per spec per run.
export async function getEncounters(client: WclQueryClient): Promise<CurrentContent> {
  const data = await client.query<{ worldData: { expansions: WclExpansion[] } }>(ENCOUNTERS_QUERY);
  const expansions = data.worldData.expansions;
  const candidates = filterEncounters(expansions);
  const protectedIds = protectedEncounterIds(expansions);

  const encounters: IngestEncounter[] = [];
  for (const zoneEncounters of groupEncountersByZone(candidates).values()) {
    if (await isZoneLive(client, zoneEncounters)) {
      encounters.push(...zoneEncounters);
    } else {
      logWarn('getEncounters', `zone "${zoneEncounters[0].zone}" dropped as non-live (no real rankings) - skipping ${zoneEncounters.length} encounter(s)`);
    }
  }
  return { encounters, protectedIds };
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
