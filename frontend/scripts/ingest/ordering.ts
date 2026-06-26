/**
 * Work-ordering for the ingestion orchestrator.
 *
 * Each run is bounded by the WCL hourly point budget: when it runs out, the loop stops and
 * the next run resumes. To stop never-ingested specs from starving (the old alphabetical
 * order always worked the same early specs first), these pure helpers order the work so a
 * budget-bounded run fills the emptiest data first. The orchestrator supplies the on-disk
 * data counts (cheap disk reads, zero WCL budget); the ordering itself is pure and total.
 */

/**
 * Specs ordered by how much data they already have on disk, least first (never-ingested
 * before partial before fully-populated), alphabetical within equal counts for stability.
 * So a budget-bounded run fills empty specs before refreshing populated ones (the populated
 * ones are cheap signature-skips anyway).
 */
export function orderSpecsByDataAscending(
  entries: ReadonlyArray<{ spec: string; dataCount: number }>,
): string[] {
  return entries
    .slice()
    .sort((a, b) => a.dataCount - b.dataCount || a.spec.localeCompare(b.spec))
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
