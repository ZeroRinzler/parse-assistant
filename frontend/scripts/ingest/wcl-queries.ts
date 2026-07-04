/**
 * GraphQL query strings and their companion `*Vars` interfaces for the WCL v2
 * client API used by the v5 ingestion's discovery step. Per-parse event/report/gear
 * queries moved to the shared Angular `WclApiService` (the transforms own them); the
 * only queries that survive here are the orchestration-level ones: the budget gate,
 * current-raid discovery, and the liveness-probe rankings. Per CLAUDE.md, every query
 * string lives here (never inlined) with a typed `*Vars` interface where parameterized.
 */

export const RATE_LIMIT_QUERY = `query { rateLimitData { limitPerHour pointsSpentThisHour pointsResetIn } }`;

// The full spec universe: all classes and their specs. `class.slug`/`spec.slug` are the exact
// `className`/`specName` the rankings query takes; the folder key is `spec.slug + class.slug`.
export const CLASSES_QUERY = `query { gameData { classes { id name slug specs { id name slug } } } }`;

export const ENCOUNTERS_QUERY = `
query {
  worldData {
    expansions {
      id name
      zones {
        id name frozen
        partitions { id name }
        encounters { id name }
      }
    }
  }
}`;

export interface RankingsQueryVars {
  encounterID: number;
  className: string;
  specName: string;
  partition?: number;
}

export const RANKINGS_QUERY = `
query($encounterID: Int!, $className: String!, $specName: String!, $partition: Int) {
  worldData {
    encounter(id: $encounterID) {
      name
      characterRankings(className: $className specName: $specName metric: dps includeCombatantInfo: true partition: $partition)
    }
  }
}`;
