// Each run is bounded by the WCL hourly point budget, so these pure helpers order work to fix the most out-of-date data first.

export const DEFAULT_PRIORITY_SPECS: readonly string[] = [];

/** Cap on how many specs one run ingests, so a single run stays within the WCL point budget. */
export const SPEC_LIMIT = 10;

const SPEC_TOKEN = /^[A-Za-z]+$/;

// Malformed input falls back to DEFAULT_PRIORITY_SPECS rather than throwing, so a typo'd repo variable can't break a run.
export function parsePrioritySpecs(raw: string | null | undefined): readonly string[] {
  if (!raw) return DEFAULT_PRIORITY_SPECS;
  const tokens = raw.split(',').map(token => token.trim()).filter(token => token.length > 0);
  if (tokens.length === 0 || !tokens.every(token => SPEC_TOKEN.test(token))) return DEFAULT_PRIORITY_SPECS;
  return tokens;
}

export interface SpecOrderEntry {
  spec: string;
  dataCount: number;
  onCurrentVersion: boolean;
}

/** Order within each version group is randomized per call so every spec gets a turn at the front over many runs. */
export function orderSpecsByVersion(
  entries: readonly SpecOrderEntry[],
  prioritySpecs: readonly string[] = DEFAULT_PRIORITY_SPECS,
  random: () => number = Math.random,
): string[] {
  const group = (entry: SpecOrderEntry): number =>
    entry.dataCount === 0 ? 0 : entry.onCurrentVersion ? 2 : 1;
  const priorityRank = new Map(prioritySpecs.map((spec, index) => [spec, index] as const));
  const priority = (entry: SpecOrderEntry): number => priorityRank.get(entry.spec) ?? prioritySpecs.length;
  // One fixed random key per entry keeps the comparator a valid total order, unlike calling random() inside it.
  return entries
    .map(entry => ({ entry, shuffleKey: random() }))
    .sort(
      (a, b) =>
        group(a.entry) - group(b.entry) ||
        priority(a.entry) - priority(b.entry) ||
        a.shuffleKey - b.shuffleKey,
    )
    .map(({ entry }) => entry.spec);
}

export interface SpecRunPlan {
  /** Every known spec, for reporting only: `selected` is what the run ingests. */
  ordered: string[];
  selected: string[];
}

export function specsForRun(
  entries: readonly SpecOrderEntry[],
  prioritySpecs: readonly string[] = DEFAULT_PRIORITY_SPECS,
): SpecRunPlan {
  const ordered = orderSpecsByVersion(entries, prioritySpecs);
  return { ordered, selected: ordered.slice(0, SPEC_LIMIT) };
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
