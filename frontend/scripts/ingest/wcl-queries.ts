/**
 * GraphQL query strings and their companion `*Vars` interfaces for the WCL v2
 * client API. Per CLAUDE.md, every query string lives here (never inlined in a
 * client method) and every parameterized query has a typed variables interface
 * (never `Record<string, unknown>`).
 */

export const RATE_LIMIT_QUERY = `query { rateLimitData { limitPerHour pointsSpentThisHour pointsResetIn } }`;

export const ENCOUNTERS_QUERY = `
query {
  worldData {
    expansions {
      id name
      zones {
        id name
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

export interface ReportMetaQueryVars { code: string; }

export const REPORT_META_QUERY = `
query($code: String!) {
  reportData { report(code: $code) {
    fights(killType: Kills) { id startTime endTime encounterID }
    masterData { actors { id name type subType gameID } }
  }}
}`;

export interface EventsQueryVars {
  code: string;
  fightIDs: number[];
  dataType: string;
  startTime: number;
  endTime: number;
  sourceID?: number;
  targetID?: number;
  includeResources?: boolean;
  hostilityType?: string;
}

export const EVENTS_QUERY = `
query GetEvents(
  $code: String! $fightIDs: [Int]! $dataType: EventDataType
  $sourceID: Int $targetID: Int $startTime: Float $endTime: Float
  $includeResources: Boolean $hostilityType: HostilityType
) {
  reportData { report(code: $code) {
    events(fightIDs: $fightIDs dataType: $dataType sourceID: $sourceID
           targetID: $targetID startTime: $startTime endTime: $endTime
           includeResources: $includeResources hostilityType: $hostilityType limit: 10000) {
      data nextPageTimestamp
    }
  }}
}`;

export interface ServerQueryVars { id: number; }

export const SERVER_QUERY = `query($id: Int!) { worldData { server(id: $id) { slug region { slug } } } }`;

/**
 * Build a batched enchant-name lookup using GraphQL field aliases so every ID is
 * resolved in one round-trip. The alias for id `N` is `eN`, matching
 * `parseEnchantResults` in wcl-mappers. Kept here (not inlined in a method) so all
 * query construction stays in the queries file.
 */
export function buildEnchantQuery(ids: Array<number | string>): string {
  const aliases = ids
    .map(id => `e${id}: enchant(id: ${id}) { id name }`)
    .join('\n    ');
  return `query { gameData { ${aliases} } }`;
}
