/** Resolves which top parses an encounter is benched from, once, so the ingest signature and every slice read the same pool. */
import { WclApiService } from '../../core/services/wcl-api';
import { TopParseSelection } from '../../core/models/wcl.models';
import { toParseRankings, unwrapRankings } from './wcl-projections';

// Over-fetch past the sampled top parses so a private or unfetchable one is backfilled by the next-best.
const CANDIDATE_POOL_DEPTH = 20;

/** Newest-first over the encounter's partitions: a patch rolls WCL's default partition over before the new one has parses, and a single default-partition read then benches nothing. */
export async function resolveTopParses(
  wclApi: WclApiService, spec: string, encounterId: number, partitionIds: readonly number[] = [],
): Promise<TopParseSelection> {
  for (const partition of (partitionIds.length ? partitionIds : [null])) {
    const raw = await wclApi.getRankings(spec, encounterId, partition);
    const rows = toParseRankings(unwrapRankings(raw), CANDIDATE_POOL_DEPTH);
    if (rows.length) return { partition, rows, depth: CANDIDATE_POOL_DEPTH };
  }
  return { partition: null, rows: [], depth: CANDIDATE_POOL_DEPTH };
}
