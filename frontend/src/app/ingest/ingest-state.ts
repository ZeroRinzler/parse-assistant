import * as z from '../core/zod-mini';
import { type IngestStamp } from './signature';

export interface SpecIngestState {
  ingest_version: number;
  ingested_at_s: number;
  empty_encounter_ids: number[];
}

const INGEST_STATE_SCHEMA = z.looseObject({
  ingest_version: z.number(),
  ingested_at_s: z.number(),
  empty_encounter_ids: z.array(z.number()),
});

/** The spec loop that reads this has no per-spec catch, so a throw here aborts the whole run. */
export function readIngestState(parsed: unknown): SpecIngestState | null {
  const file = INGEST_STATE_SCHEMA.safeParse(parsed);
  if (!file.success) return null;
  const { ingest_version, ingested_at_s, empty_encounter_ids } = file.data;
  return { ingest_version, ingested_at_s, empty_encounter_ids };
}

export function nextIngestState(
  previous: SpecIngestState | null,
  emptyThisPass: readonly number[],
  benchedIds: ReadonlySet<number>,
  stamp: IngestStamp,
): SpecIngestState {
  const marked = new Set([...(previous?.empty_encounter_ids ?? []), ...emptyThisPass]);
  return {
    ingest_version: stamp.version,
    ingested_at_s: stamp.ingestedAtS,
    empty_encounter_ids: [...marked].filter(id => !benchedIds.has(id)).sort((a, b) => a - b),
  };
}

/** Null when nothing changed: writing anyway restamps every marker each run and the age column stops naming the real last check. */
export function prunedIngestState(
  previous: SpecIngestState | null,
  keepIds: ReadonlySet<number>,
): SpecIngestState | null {
  if (!previous) return null;
  const kept = previous.empty_encounter_ids.filter(id => keepIds.has(id));
  if (kept.length === previous.empty_encounter_ids.length) return null;
  return { ...previous, empty_encounter_ids: kept };
}

/** The file server's crashed temp writes are named `<id>.json.<pid>.<n>.tmp`, so only an exact `.json` name is an encounter. */
export function encounterIdsFromFiles(files: readonly string[]): number[] {
  return files
    .filter(file => file.endsWith('.json'))
    .map(file => parseInt(file))
    .filter(id => Number.isFinite(id))
    .sort((a, b) => a - b);
}
