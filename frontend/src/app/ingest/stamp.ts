// A second declaration of these stamped field names drifts from the files already on disk.
import * as z from '../core/zod-mini';
import { type Result } from '../core/result';
import { INGEST_VERSION } from './ingest-version';
import { encounterSkipKey, type SignatureRanking } from './signature';

interface StampedFile {
  source_signature?: string;
  ingest_version: number;
  // Reporting only: never read by the skip check or the work-ordering.
  ingested_at_s?: number;
  // Burst-file-only: parses found permission-denied by the producing run, so the next cheap hash check can exclude them.
  inaccessible_parses?: string[];
}

export interface IngestStamp {
  version: number;
  ingestedAtS: number;
}

interface StoredStamp {
  signature: string | null;
  version: number | null;
  ingestedAtS: number | null;
  inaccessibleParses: Set<string>;
}

/** `source_signature` drives the skip check; the bare `ingest_version` drives the work-ordering. */
export function stampSignature<T extends object>(data: T, signature: string, stamp: IngestStamp): T & StampedFile {
  return { ...data, source_signature: signature, ingest_version: stamp.version, ingested_at_s: stamp.ingestedAtS };
}

/** Burst stamp: writes `source_signature` only when no slice failed (a `missing` slice is legitimate empty data), so a transient/permanent failure leaves it unstamped and the next run redoes the encounter. */
export function stampBurstFile<T extends object>(
  data: T, signature: string, stamp: IngestStamp, inaccessibleParses: string[],
  sliceResults: readonly Result<unknown>[],
): T & StampedFile {
  const complete = sliceResults.every(result => result.ok || result.error.kind === 'missing');
  const versioned: T & StampedFile = {
    ...data, ingest_version: stamp.version, ingested_at_s: stamp.ingestedAtS, inaccessible_parses: inaccessibleParses,
  };
  return complete ? { ...versioned, source_signature: signature } : versioned;
}

function readStamp(file: unknown): StoredStamp {
  const stamped = file as Partial<StampedFile> | null | undefined;
  return {
    signature: stamped?.source_signature ?? null,
    version: stamped?.ingest_version ?? null,
    ingestedAtS: stamped?.ingested_at_s ?? null,
    inaccessibleParses: new Set(stamped?.inaccessible_parses ?? []),
  };
}

export function readFileStamp(file: unknown): { version: number | null; ingestedAtS: number | null } {
  const { version, ingestedAtS } = readStamp(file);
  return { version, ingestedAtS };
}

export function skipDecision(
  file: unknown, rows: SignatureRanking[], version: string, topN: number,
): { skip: boolean; signature: string } {
  const stored = readStamp(file);
  const signature = encounterSkipKey(rows, stored.inaccessibleParses, version, topN);
  return { skip: stored.signature === signature, signature };
}

const VERSIONED_FILE_SCHEMA = z.looseObject({ ingest_version: z.number() });

/** Files with no numeric `ingest_version` (manifests, rulebooks) are never future. */
export function isFutureVersion(parsed: unknown): boolean {
  const file = VERSIONED_FILE_SCHEMA.safeParse(parsed);
  return file.success && file.data.ingest_version > INGEST_VERSION;
}
