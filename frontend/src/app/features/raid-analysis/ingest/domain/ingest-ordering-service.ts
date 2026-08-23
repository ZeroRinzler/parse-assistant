import { Injectable } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class IngestOrderingService {

  // Malformed input falls back to no priority spec rather than throwing, so a typo'd repo variable can't break a run.
  parsePrioritySpecs(raw: string | null | undefined): readonly string[] {
    if (!raw) return [];
    const tokens = raw.split(',').map(token => token.trim()).filter(token => token.length > 0);
    if (tokens.length === 0 || !tokens.every(token => SPEC_TOKEN.test(token))) return [];
    return tokens;
  }

  /** Order within each version group is randomized per call so every spec gets a turn at the front over many runs. */
  orderSpecsByVersion(
    entries: readonly SpecOrderEntry[],
    prioritySpecs: readonly string[],
    random: () => number = Math.random,
  ): string[] {
    const group = (entry: SpecOrderEntry): number =>
      entry.checkedCount === 0 ? 0 : entry.onCurrentVersion ? 2 : 1;
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

  specsForRun(
    entries: readonly SpecOrderEntry[],
    prioritySpecs: readonly string[],
  ): SpecRunPlan {
    const ordered = this.orderSpecsByVersion(entries, prioritySpecs);
    return { ordered, selected: ordered.slice(0, SPEC_LIMIT) };
  }

  /** So a partially ingested spec fills the bosses it has never been checked against before re-checking the ones already settled. */
  orderEncountersByMissingFirst<T extends { id: number }>(
    encounters: readonly T[],
    checkedIds: ReadonlySet<number>,
  ): T[] {
    return encounters
      .map((encounter, index) => ({ encounter, index }))
      .sort(
        (a, b) =>
          Number(checkedIds.has(a.encounter.id)) - Number(checkedIds.has(b.encounter.id)) ||
          a.index - b.index,
      )
      .map(item => item.encounter);
  }
}

// Each run is bounded by the WCL hourly point budget, so these pure helpers order work to fix the most out-of-date data first.

/** Cap on how many specs one run ingests, so a single run stays within the WCL point budget. */
export const SPEC_LIMIT = 10;

const SPEC_TOKEN = /^[A-Za-z]+$/;

export interface SpecOrderEntry {
  spec: string;
  /** Encounters with a bench plus those checked and found to have no Mythic parses. */
  checkedCount: number;
  onCurrentVersion: boolean;
}

export interface SpecRunPlan {
  /** Every known spec, for reporting only: `selected` is what the run ingests. */
  ordered: string[];
  selected: string[];
}
