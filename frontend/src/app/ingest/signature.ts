// A tailored file is fresh when the ingest version AND the exact top-parse set that produced it are unchanged, folded into one short hash.
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { type Result } from '../core/result';

/** Satisfied by the shared `toParseRankings` selection's rows, so the signature keys on exactly the parses that feed the transforms. */
export interface SignatureRanking {
  report_code: string;
  fight_id: number;
}

/** `report_code:fight_id` key - the unit of the parse-set fingerprint and the inaccessible set. */
export function parseKey(ranking: SignatureRanking): string {
  return `${ranking.report_code}:${ranking.fight_id}`;
}

export function readInaccessibleParses(file: { inaccessible_parses?: string[] } | null | undefined): Set<string> {
  return new Set(file?.inaccessible_parses ?? []);
}

export interface SignedFile {
  source_signature?: string;
  ingest_version: number;
  // Burst-file-only: parses found permission-denied by the producing run, so the next cheap hash check can exclude them.
  inaccessible_parses?: string[];
}

/** Stable `report_code:fight_id` list, sorted, so ranking order never affects the hash. */
function rankingFingerprint(rankings: SignatureRanking[]): string {
  return rankings
    .map(ranking => `${ranking.report_code}:${ranking.fight_id}`)
    .sort()
    .join('|');
}

export function encounterSignature(version: string, rankings: SignatureRanking[]): string {
  return bytesToHex(sha256(utf8ToBytes(`${version}\n${rankingFingerprint(rankings)}`))).slice(0, 16);
}

/** The signature over the top-`topN` ACCESSIBLE parses - the one rule both the cheap pre-check and the post-fetch stamp key on, so they can never diverge. */
export function encounterSkipKey(
  poolRows: SignatureRanking[], inaccessible: Set<string>, version: string, topN: number,
): string {
  const usedRows = poolRows.filter(row => !inaccessible.has(parseKey(row))).slice(0, topN);
  return encounterSignature(version, usedRows);
}

/** Persist only permission-denied `inaccessibleCodes`; sign the top-N minus every `failedCodes` fetch, so a backfilled bench is stamped as the set it used. */
export function signatureAfterFetch(
  poolRows: SignatureRanking[], inaccessibleCodes: Set<string>, failedCodes: Set<string>, version: string, topN: number,
): { signature: string; inaccessibleParses: string[] } {
  const inaccessibleParses = poolRows.filter(row => inaccessibleCodes.has(row.report_code)).map(parseKey);
  const failedParses = poolRows.filter(row => failedCodes.has(row.report_code)).map(parseKey);
  const signature = encounterSkipKey(poolRows, new Set(failedParses), version, topN);
  return { signature, inaccessibleParses };
}

export function readStoredSignature(file: { source_signature?: string } | null | undefined): string | null {
  return file?.source_signature ?? null;
}

export function readStoredVersion(file: SignedFile): number {
  return file.ingest_version;
}

/** Files with no numeric `ingest_version` (manifests, rulebooks) are never future. */
export function isFutureVersion(parsed: unknown, currentVersion: number): boolean {
  if (typeof parsed !== 'object' || parsed === null) return false;
  const version = (parsed as { ingest_version?: unknown }).ingest_version;
  return typeof version === 'number' && Number.isFinite(version) && version > currentVersion;
}

export function signatureMatches(stored: string | null, current: string): boolean {
  return stored != null && stored === current;
}

/** `source_signature` drives the skip check; the bare `ingest_version` drives the work-ordering. */
export function stampSignature<T extends object>(data: T, signature: string, version: number): T & SignedFile {
  return { ...data, source_signature: signature, ingest_version: version };
}

/** Burst stamp: writes `source_signature` only when no slice failed (a `missing` slice is legitimate empty data), so a transient/permanent failure leaves it unstamped and the next run redoes the encounter. */
export function stampBurstFile<T extends object>(
  data: T, signature: string, version: number, inaccessibleParses: string[],
  sliceResults: readonly Result<unknown>[],
): T & SignedFile {
  const complete = sliceResults.every(result => result.ok || result.error.kind === 'missing');
  const versioned: T & SignedFile = { ...data, ingest_version: version, inaccessible_parses: inaccessibleParses };
  return complete ? { ...versioned, source_signature: signature } : versioned;
}
