/**
 * Ingest discovery layer: resolves which raids are "current" from `worldData` plus a
 * cheap rankings liveness probe - the one piece of orchestration the transforms do not
 * own. Accepts a `WclQueryClient` so tests can inject a fake; best-effort failures are
 * logged via `logWarn`, never swallowed.
 */

import { logWarn } from '../core/log';
import { toParseRankings, unwrapRankings } from '../shared/analysis/wcl-projections';
import { ENCOUNTERS_Q, RANKINGS_Q, type RankingsQueryVars } from '../core/services/wcl-queries';
import type { ParseRanking, WclRankingsBlob } from '../core/models/wcl.models';
import { BudgetExceededError, type WclQueryClient } from './wcl-client';
import {
  filterEncounters, groupEncountersByZone, protectedEncounterIds, type SpecWclMap,
} from './wcl-mappers';
import type { WclExpansion, IngestEncounter } from './models/wcl.models';

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

// BudgetExceeded propagates (a clean stop); other per-spec probe errors are logged and
// treated as zero so one flaky spec cannot sink a live zone.
async function isZoneLive(client: WclQueryClient, zoneEncounters: IngestEncounter[], specWcl: SpecWclMap): Promise<boolean> {
  const probeEncounter = zoneEncounters[0];
  if (!probeEncounter) return false;
  let realCount = 0;
  for (const probeSpec of PROBE_SPECS) {
    await client.assertBudget(PROBE_BUDGET_MARGIN);
    try {
      const ranked = await getRankingsLite(client, probeSpec, probeEncounter.id, specWcl, PROBE_COUNT, probeEncounter.partitionIds);
      realCount += ranked.length;
      if (realCount >= LIVE_RANKINGS_THRESHOLD) return true;
    } catch (err) {
      if (err instanceof BudgetExceededError) throw err;
      logWarn(`getEncounters probe ${probeEncounter.name} (${probeSpec})`, err);
    }
  }
  return false;
}

// The probe runs once per zone here, not per spec, so beta/PTR/test zones cost a
// handful of queries total instead of one per spec per run.
export async function getEncounters(client: WclQueryClient, specWcl: SpecWclMap): Promise<CurrentContent> {
  const data = await client.query<{ worldData: { expansions: WclExpansion[] } }>(ENCOUNTERS_Q);
  const expansions = data.worldData.expansions;
  const candidates = filterEncounters(expansions);
  const protectedIds = protectedEncounterIds(expansions);

  const encounters: IngestEncounter[] = [];
  for (const zoneEncounters of groupEncountersByZone(candidates).values()) {
    if (await isZoneLive(client, zoneEncounters, specWcl)) {
      encounters.push(...zoneEncounters);
    } else {
      logWarn('getEncounters', `zone "${zoneEncounters[0].zone}" dropped as non-live (no real rankings) - skipping ${zoneEncounters.length} encounter(s)`);
    }
  }
  return { encounters, protectedIds };
}

// Partitions are tried newest-first because a fresh patch's partition carries the
// current parses; a zone with no partitions falls back to null (WCL's current).
export async function getRankingsLite(
  client: WclQueryClient, spec: string, encounterId: number, specWcl: SpecWclMap, count = 10, partitionIds: number[] = [],
): Promise<ParseRanking[]> {
  const mapping = specWcl[spec];
  if (!mapping) throw new Error(`Unknown spec: ${spec}`);
  const [className, specName] = mapping;

  const attempts: (number | null)[] = partitionIds.length > 0 ? partitionIds : [null];
  for (const partition of attempts) {
    const variables: RankingsQueryVars = { encounterID: encounterId, className, specName };
    if (partition != null) variables.partition = partition;
    const data = await client.query<{ worldData: { encounter: { characterRankings: WclRankingsBlob } } }, RankingsQueryVars>(RANKINGS_Q, variables);
    const mapped = toParseRankings(unwrapRankings(data.worldData.encounter.characterRankings), count);
    if (mapped.length > 0) return mapped;
  }
  return [];
}
