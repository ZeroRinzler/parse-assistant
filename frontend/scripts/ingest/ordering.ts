/**
 * Work-ordering for the ingestion orchestrator.
 *
 * Each run is bounded by the WCL hourly point budget: when it runs out, the loop stops and
 * the next run resumes. To stop stale specs from starving (the old order always worked the
 * same early specs first), these pure helpers order the work so a budget-bounded run fixes
 * the most out-of-date data first. The orchestrator supplies cheap disk/git signals (zero
 * WCL budget); the ordering itself is pure and total.
 */

/** Spec pinned to the front of its bracket, ahead of the time/alphabetical order. */
export const PRIORITY_SPEC = 'SubtletyRogue';

/** One spec's ordering inputs - all derived from cheap disk + git reads. */
export interface SpecOrderEntry {
  spec: string;
  /** Burst files on disk (0 = never ingested). */
  dataCount: number;
  /** True only when every on-disk file is at the current INGEST_VERSION. */
  onCurrentVersion: boolean;
  /** Git last-commit unix seconds of the spec's data dir; null = no history (oldest). */
  lastChange: number | null;
}

/**
 * Specs ordered so a budget-bounded run fixes the most out-of-date data first:
 *   1. empty specs (never ingested),
 *   2. old-version specs (data not fully at the current INGEST_VERSION),
 *   3. current-version specs,
 * PRIORITY_SPEC is pinned to the front of its own bracket (ahead of time/alphabetical), so it
 * is always refreshed first among specs in the same version group. Otherwise, within each group
 * oldest git-commit time first (a null/absent time counts as oldest), with an alphabetical
 * tiebreak to keep the order stable when times are equal. So a code/version bump refreshes the
 * stalest specs before re-checking the freshly-rewritten ones.
 */
export function orderSpecsByVersionThenTime(entries: ReadonlyArray<SpecOrderEntry>): string[] {
  const group = (entry: SpecOrderEntry): number =>
    entry.dataCount === 0 ? 0 : entry.onCurrentVersion ? 2 : 1;
  const priority = (entry: SpecOrderEntry): number => (entry.spec === PRIORITY_SPEC ? 0 : 1);
  const time = (entry: SpecOrderEntry): number => entry.lastChange ?? -Infinity;
  return entries
    .slice()
    .sort(
      (a, b) =>
        group(a) - group(b) || priority(a) - priority(b) || time(a) - time(b) || a.spec.localeCompare(b.spec),
    )
    .map(entry => entry.spec);
}

/**
 * Encounters ordered so the ones missing an on-disk slice come first (never-ingested before
 * already-present), keeping the original relative order within each group. So a partially
 * ingested spec fills its remaining bosses before re-checking the ones already done.
 */
export function orderEncountersByMissingFirst<T extends { id: number }>(
  encounters: readonly T[],
  presentIds: ReadonlySet<number>,
): T[] {
  return encounters
    .map((encounter, index) => ({ encounter, index }))
    .sort(
      (a, b) =>
        Number(presentIds.has(a.encounter.id)) - Number(presentIds.has(b.encounter.id)) ||
        a.index - b.index,
    )
    .map(item => item.encounter);
}
