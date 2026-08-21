// A second declaration of these stamped field names drifts from the files already on disk.
import * as z from '../../zod-mini';

export interface StampedFile {
  source_signature?: string;
  ingest_version: number;
  // Reporting only: never read by the skip check or the work-ordering.
  ingested_at_s?: number;
  // Burst-file-only: parses found permission-denied by the producing run, so the next cheap hash check can exclude them.
  inaccessible_parses?: string[];
}

interface StoredMetadata {
  signature: string | null;
  version: number | null;
  ingestedAtS: number | null;
  inaccessibleParses: Set<string>;
}

export function readStoredMetadata(file: Partial<StampedFile> | null | undefined): StoredMetadata {
  return {
    signature: file?.source_signature ?? null,
    version: file?.ingest_version ?? null,
    ingestedAtS: file?.ingested_at_s ?? null,
    inaccessibleParses: new Set(file?.inaccessible_parses ?? []),
  };
}

export function signatureMatches(stored: string | null, current: string): boolean {
  return stored != null && stored === current;
}

const VERSIONED_FILE_SCHEMA = z.looseObject({ ingest_version: z.number() });

/** Files with no numeric `ingest_version` (manifests, rulebooks) are never future. */
export function isFutureVersion(parsed: unknown, currentVersion: number): boolean {
  const file = VERSIONED_FILE_SCHEMA.safeParse(parsed);
  return file.success && file.data.ingest_version > currentVersion;
}
