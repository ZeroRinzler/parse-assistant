// Each run is bounded by the WCL hourly point budget, so these pure helpers order work to fix the most out-of-date data first.

/** Spec pinned to the front of its bracket, ahead of the rest of the order. */
export const PRIORITY_SPEC = 'SubtletyRogue';

/** Cap on how many specs one run ingests, so a single run stays within the WCL point budget. */
export const SPEC_LIMIT = 10;

export interface SpecOrderEntry {
  spec: string;
  dataCount: number;
  onCurrentVersion: boolean;
}

/** Order within each version group is randomized per call so every spec gets a turn at the front over many runs. */
export function orderSpecsByVersion(
  entries: readonly SpecOrderEntry[],
  random: () => number = Math.random,
): string[] {
  const group = (entry: SpecOrderEntry): number =>
    entry.dataCount === 0 ? 0 : entry.onCurrentVersion ? 2 : 1;
  const priority = (entry: SpecOrderEntry): number => (entry.spec === PRIORITY_SPEC ? 0 : 1);
  // One fixed random key per entry keeps the comparator a valid total order, unlike calling random() inside it.
  const shuffleKey = new Map(entries.map(entry => [entry, random()] as const));
  return entries
    .slice()
    .sort(
      (a, b) =>
        group(a) - group(b) ||
        priority(a) - priority(b) ||
        shuffleKey.get(a)! - shuffleKey.get(b)!,
    )
    .map(entry => entry.spec);
}

export function specsForRun(
  entries: readonly SpecOrderEntry[],
  random: () => number = Math.random,
): string[] {
  return orderSpecsByVersion(entries, random).slice(0, SPEC_LIMIT);
}

/** So a partially ingested spec fills its remaining bosses before re-checking the ones already done. */
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
