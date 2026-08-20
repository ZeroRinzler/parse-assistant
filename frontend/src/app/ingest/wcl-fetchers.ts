// Accepts a `WclQueryClient` so tests can inject a fake; best-effort failures are logged via `logWarn`, never swallowed.

import { logWarn } from '../core/log';
import { toParseRankings, unwrapRankings } from '../shared/analysis/wcl-projections';
import { ENCOUNTERS_Q, RANKINGS_Q } from '../core/services/wcl-queries';
import type {
  EncountersQuery, RankingsQuery, RankingsQueryVariables,
} from '../core/services/wcl-operations.generated';
import { MYTHIC_DIFFICULTY, type ParseRanking } from '../core/models/wcl.models';
import { BudgetExceededError, type WclQueryClient } from './wcl-client';
import {
  filterEncounters, groupEncountersByZone, protectedEncounterIds, type SpecWclMap,
} from './wcl-mappers';
import type { IngestEncounter } from './models/wcl.models';

// A genuinely live raid has many real parses for any of these; a beta/PTR/test zone has none.
const PROBE_SPECS = ['FireMage', 'RetributionPaladin', 'FuryWarrior'];
// >=1 is unsafe: a single non-anon parse on a test boss would promote it; a real raid clears this easily.
const LIVE_RANKINGS_THRESHOLD = 3;
const PROBE_COUNT = 10;
const PROBE_BUDGET_MARGIN = 500;
const HEROIC_DIFFICULTY = 4;
const NORMAL_DIFFICULTY = 3;
// A raid is open for days before its first Mythic kills land, so a Mythic-only probe would read a just-opened raid as dead.
const PROBE_DIFFICULTIES = [MYTHIC_DIFFICULTY, HEROIC_DIFFICULTY, NORMAL_DIFFICULTY];

export interface CurrentContent {
  // Confirmed live by the rankings probe.
  encounters: IngestEncounter[];
  protectedIds: Set<number>;
}

// BudgetExceeded propagates (a clean stop); other per-spec probe errors are logged as zero so one flaky spec can't sink a live zone.
async function isZoneLive(client: WclQueryClient, zoneEncounters: IngestEncounter[], specWcl: SpecWclMap): Promise<boolean> {
  const probeEncounter = zoneEncounters[0];
  if (!probeEncounter) return false;
  let realCount = 0;
  for (const probeSpec of PROBE_SPECS) {
    await client.assertBudget(PROBE_BUDGET_MARGIN);
    for (const difficulty of PROBE_DIFFICULTIES) {
      try {
        const ranked = await getRankingsLite(client, probeSpec, probeEncounter.id, specWcl, PROBE_COUNT, probeEncounter.partitionIds, difficulty);
        realCount += ranked.length;
        if (realCount >= LIVE_RANKINGS_THRESHOLD) return true;
      } catch (err) {
        if (err instanceof BudgetExceededError) throw err;
        logWarn(`getEncounters probe ${probeEncounter.name} (${probeSpec})`, err);
      }
    }
  }
  return false;
}

// Zones are probed newest-first and the FIRST live one is the whole current content: the previous tier keeps real rankings after a new raid opens, so keeping every live zone would never phase it out.
export async function getEncounters(client: WclQueryClient, specWcl: SpecWclMap): Promise<CurrentContent> {
  const data = await client.query<EncountersQuery>(ENCOUNTERS_Q);
  // An empty expansion tree would silently protect no encounter and publish an empty summary.
  if (!data.worldData?.expansions) throw new Error('WCL returned no worldData.expansions.');
  const expansions = data.worldData.expansions;
  const candidates = filterEncounters(expansions);

  const zonesNewestFirst = [...groupEncountersByZone(candidates).values()]
    .sort((a, b) => (b[0]?.zoneId ?? 0) - (a[0]?.zoneId ?? 0));
  for (const zoneEncounters of zonesNewestFirst) {
    if (await isZoneLive(client, zoneEncounters, specWcl)) {
      return { encounters: zoneEncounters, protectedIds: protectedEncounterIds(expansions, zoneEncounters[0]?.zoneId ?? null) };
    }
    logWarn('getEncounters', `zone "${zoneEncounters[0]?.zone}" dropped as non-live (no real rankings) - skipping ${zoneEncounters.length} encounter(s)`);
  }
  return { encounters: [], protectedIds: protectedEncounterIds(expansions, null) };
}

/** Newest-first, since a fresh patch's partition carries the current parses; it reports which one answered because the signature, the transforms and the liveness probe have to read the same one, and a patch rolling the default over to a still-empty partition is where they would otherwise diverge. */
export async function rankingsFromPartition<T>(
  partitionIds: number[], fetch: (partition: number | null) => Promise<T[]>,
): Promise<{ rows: T[]; partition: number | null }> {
  for (const partition of (partitionIds.length ? partitionIds : [null])) {
    const rows = await fetch(partition);
    if (rows.length) return { rows, partition };
  }
  return { rows: [], partition: null };
}

export async function getRankingsLite(
  client: WclQueryClient, spec: string, encounterId: number, specWcl: SpecWclMap, count: number, partitionIds: number[], difficulty: number,
): Promise<ParseRanking[]> {
  const mapping = specWcl[spec];
  if (!mapping) throw new Error(`Unknown spec: ${spec}`);
  const [className, specName] = mapping;

  const { rows } = await rankingsFromPartition(partitionIds, async partition => {
    const variables: RankingsQueryVariables = { encounterID: encounterId, className, specName, difficulty };
    if (partition != null) variables.partition = partition;
    const data = await client.query<RankingsQuery>(RANKINGS_Q, variables);
    return toParseRankings(unwrapRankings(data.worldData?.encounter?.characterRankings), count);
  });
  return rows;
}
