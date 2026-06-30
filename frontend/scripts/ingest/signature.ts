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

/** The raw WCL ranking fields the selection reads (structural, no transport coupling). */
export interface RawSignatureRanking {
  name?: string;
  report?: { code?: string; fightID?: number };
}

// WCL surfaces a privacy-hidden parse in rankings with an anonymized "Character <id>-<id>"
// name (real names are letters only), so it can never match a report actor and the
// transforms drop it as unfetchable. The WCL API has no flag to exclude these, so the
// filter is client-side - and the signature applies the same one so the hash keys on the
// parses that actually feed the data. Keep in lockstep with the transforms' regex.
const ANONYMIZED_NAME = /^Character \d+-\d+$/;

/** `report_code:fight_id` key - the unit of the parse-set fingerprint and the inaccessible set. */
export function parseKey(ranking: SignatureRanking): string {
  return `${ranking.report_code}:${ranking.fight_id}`;
}

/**
 * The candidate parse set the signature draws from - identical to the transforms'
 * `toParseRankings(raw, count)` selection (drop anonymized + no-code rows, take the top
 * `count`), minus the unused player field.
 */
export function selectSignatureRankings(raw: RawSignatureRanking[], count: number): SignatureRanking[] {
  return raw
    .filter(ranking => ranking.report?.code && !ANONYMIZED_NAME.test(ranking.name ?? ''))
    .slice(0, count)
    .map(ranking => ({ report_code: ranking.report?.code ?? '', fight_id: ranking.report?.fightID ?? 0 }));
}

/** The persisted `report_code:fight_id` keys known inaccessible (permission-denied) last run. */
export function readInaccessibleParses(file: { inaccessible_parses?: string[] } | null | undefined): Set<string> {
  return new Set(file?.inaccessible_parses ?? []);
}

/**
 * A stored tailored file carries its producing signature for the skip check, plus the
 * bare ingest version for the work-ordering. `ingest_version` is required: every write
 * stamps it and the migration backfilled it onto pre-existing files.
 */
export interface SignedFile {
  source_signature?: string;
  ingest_version: number;
  // Only the canonical burst file carries this: the report_code:fight_id keys found
  // inaccessible (permission-denied) during the run that produced it, so the next cheap
  // hash check can exclude them without re-fetching.
  inaccessible_parses?: string[];
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

/**
 * The encounter's skip key: the signature over the top-`topN` ACCESSIBLE parses (the
 * candidate pool minus the parses already known inaccessible). This is the one rule both
 * the cheap pre-check and the post-fetch stamp key on, so they can never diverge.
 *
 * `inaccessible` is a set of `report_code:fight_id` keys (see `parseKey`) - the persisted
 * set on the cheap check, the freshly discovered one after a fetch.
 */
export function encounterSkipKey(
  poolRows: SignatureRanking[], inaccessible: Set<string>, version: string, topN: number,
): string {
  const usedRows = poolRows.filter(row => !inaccessible.has(parseKey(row))).slice(0, topN);
  return encounterSignature(version, usedRows);
}

/**
 * The post-fetch stamp decision: given the report codes a run found inaccessible
 * (permission-denied), derive both the inaccessible parse keys to persist on the burst
 * file AND the signature to stamp (keyed on the top-`topN` accessible parses). Parses
 * never fetched - those below the `topN`th accessible - are naturally pruned, since only
 * the codes the transforms actually hit are reported inaccessible.
 *
 * `inaccessibleCodes` is a set of bare report codes (what the transport reports), distinct
 * from `encounterSkipKey`'s set of `report_code:fight_id` keys - the conversion happens here.
 */
export function signatureAfterFetch(
  poolRows: SignatureRanking[], inaccessibleCodes: Set<string>, version: string, topN: number,
): { signature: string; inaccessibleParses: string[] } {
  const inaccessibleParses = poolRows.filter(row => inaccessibleCodes.has(row.report_code)).map(parseKey);
  const signature = encounterSkipKey(poolRows, new Set(inaccessibleParses), version, topN);
  return { signature, inaccessibleParses };
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
