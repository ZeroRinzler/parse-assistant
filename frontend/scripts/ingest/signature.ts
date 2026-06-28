/**
 * Per-encounter output signature for the v5 orchestrator.
 *
 * A tailored file is fresh when (a) the ingest version that produced it is unchanged
 * and (b) the exact set of top parses feeding it is unchanged. `encounterSignature`
 * folds both into one short hash: the manual ingest version (see ingest-version.ts) plus
 * the sorted `report_code:fight_id` of the current rankings. The orchestrator stamps the
 * hash onto every written file as `source_signature`; on the next run it recomputes the
 * signature from the fresh (cheap, cached) rankings query and skips the encounter entirely
 * when it matches the stored value - spending only the rankings read.
 *
 * Each file also carries the bare `ingest_version` integer (the same value, unhashed) so
 * the work-ordering can tell stale-version data from current without recomputing anything.
 *
 * This is the v5 analogue of the legacy per-sample `ingest_hash` + freshness window,
 * but keyed to the actual parse set rather than a wall-clock age, so an unchanged
 * leaderboard is never re-fetched and a changed one always is.
 */
import crypto from 'crypto';

/** The minimal ranking shape the signature needs (report + fight identity). */
export interface SignatureRanking {
  report_code: string;
  fight_id: number;
}

/**
 * A stored tailored file carries its producing signature for the skip check, plus the
 * bare ingest version for the work-ordering. `ingest_version` is required: every write
 * stamps it and the migration backfilled it onto pre-existing files.
 */
export interface SignedFile {
  source_signature?: string;
  ingest_version: number;
}

/** Stable `report_code:fight_id` list, sorted, so ranking order never affects the hash. */
function rankingFingerprint(rankings: SignatureRanking[]): string {
  return rankings
    .map(ranking => `${ranking.report_code}:${ranking.fight_id}`)
    .sort()
    .join('|');
}

/** sha256 (first 16 hex) of the ingest version + the sorted parse-set fingerprint. */
export function encounterSignature(version: string, rankings: SignatureRanking[]): string {
  return crypto
    .createHash('sha256')
    .update(`${version}\n${rankingFingerprint(rankings)}`)
    .digest('hex')
    .slice(0, 16);
}

/** Read the `source_signature` stamped on an existing tailored file (null when absent). */
export function readStoredSignature(file: { source_signature?: string } | null | undefined): string | null {
  return file?.source_signature ?? null;
}

/** Read the `ingest_version` stamped on an existing tailored file (the migration guarantees it). */
export function readStoredVersion(file: SignedFile): number {
  return file.ingest_version;
}

/**
 * True when a previously written file's stamped signature matches the freshly computed
 * one: nothing the output depends on (transform code or parse set) has changed, so the
 * encounter can be skipped. A missing stored signature never matches (always recompute).
 */
export function signatureMatches(stored: string | null, current: string): boolean {
  return stored != null && stored === current;
}

/**
 * Return a shallow copy of `data` with the signature + ingest version stamped on (added
 * before writing). `source_signature` drives the skip check; `ingest_version` (the bare
 * integer) drives the work-ordering.
 */
export function stampSignature<T extends object>(data: T, signature: string, version: number): T & SignedFile {
  return { ...data, source_signature: signature, ingest_version: version };
}
