/**
 * WCL GraphQL query strings and their typed variable interfaces.
 *
 * Keep query strings here and nowhere else. Each query has a companion
 * *Vars interface so callers get static type checking on variables rather
 * than the stringly-typed `Record<string, unknown>` fallback.
 */

// ---------------------------------------------------------------------------
// Variable interfaces
// ---------------------------------------------------------------------------

export interface ReportQueryVars { code: string }
export interface PlayerDetailsQueryVars { code: string; fightIDs: number[] }
export interface EventsQueryVars {
  code: string;
  fightIDs: number[];
  dataType: string;
  startTime: number;
  endTime: number;
  sourceID?: number;
  includeResources?: boolean;
  hostilityType?: 'Friendlies' | 'Enemies';
}
export interface CombatantInfoQueryVars { code: string; fightIDs: number[]; sourceID: number }
export interface RankingsQueryVars { encounterID: number; className: string; specName: string }
export interface TableQueryVars { code: string; fightIDs: number[]; dataType: string }
export interface ResurrectsQueryVars { code: string; fightIDs: number[]; filter: string; startTime: number; endTime: number }

// ---------------------------------------------------------------------------
// Query strings
// ---------------------------------------------------------------------------

export const REPORT_Q = `
query($code:String!){reportData{report(code:$code){
  title
  startTime
  fights(killType:All){id name startTime endTime kill encounterID difficulty friendlyPlayers fightPercentage}
  masterData{
    actors(type:"Player"){id name subType server}
    enemies:actors(type:"NPC"){id name gameID}
    abilities{gameID name icon}
  }
}}}`;

export const PLAYER_DETAILS_Q = `
query($code:String!,$fightIDs:[Int]!){
  reportData{report(code:$code){playerDetails(fightIDs:$fightIDs)}}
}`;

export const EVENTS_Q = `
query($code:String!,$fightIDs:[Int]!,$dataType:EventDataType,$sourceID:Int,$startTime:Float,$endTime:Float,$includeResources:Boolean,$hostilityType:HostilityType){
  reportData{report(code:$code){
    events(fightIDs:$fightIDs,dataType:$dataType,sourceID:$sourceID,
           startTime:$startTime,endTime:$endTime,includeResources:$includeResources,hostilityType:$hostilityType,limit:10000){data nextPageTimestamp}
  }}
}`;

/**
 * Damage-done summary table for a fight. Returns a JSON blob whose `data.entries` holds
 * one row per source actor (`id`, `total`); the caller picks its player and derives DPS
 * from `total` over the fight duration. This is the whole pull's table (no source filter),
 * because filtering by `sourceID` regroups the rows by ability rather than by player.
 */
export const TABLE_Q = `
query($code:String!,$fightIDs:[Int]!,$dataType:TableDataType){
  reportData{report(code:$code){table(fightIDs:$fightIDs,dataType:$dataType)}}
}`;

/**
 * Resurrect events for a fight. WCL has no `Resurrects` data type, so this scans `All`
 * with a server-side `filterExpression` (only the matching events come back), so the wipe
 * analysis can tell when a dead player is brought back. Paginated like the events reader.
 */
export const RESURRECTS_Q = `
query($code:String!,$fightIDs:[Int]!,$filter:String,$startTime:Float,$endTime:Float){
  reportData{report(code:$code){
    events(fightIDs:$fightIDs,dataType:All,filterExpression:$filter,startTime:$startTime,endTime:$endTime,limit:10000){data nextPageTimestamp}
  }}
}`;

/**
 * Top DPS parses for an encounter + spec. `characterRankings` returns a JSON blob
 * (string or object) carrying each parse's report code + fight id + player name -
 * enough for the burst transform to refetch and recompute the bench live.
 */
export const RANKINGS_Q = `
query($encounterID:Int!,$className:String!,$specName:String!){
  worldData{encounter(id:$encounterID){
    characterRankings(className:$className,specName:$specName,metric:dps)
  }}
}`;

/** Fetch CombatantInfo for a single player actor in a specific fight. */
export const COMBATANT_INFO_Q = `
query($code:String!,$fightIDs:[Int]!,$sourceID:Int){
  reportData{report(code:$code){
    events(fightIDs:$fightIDs,dataType:CombatantInfo,sourceID:$sourceID){data}
  }}
}`;

/**
 * Build a batched `gameData { ... }` query that resolves trinket item names and
 * enchant names by ID in a single round-trip. Item aliases are prefixed `i`,
 * enchant aliases `e` (bare numeric identifiers are not valid GraphQL field names).
 * Enchant names may contain HTML entities - callers must decode them.
 */
export function buildGearNamesQuery(itemIds: number[], enchantIds: number[]): string {
  const fields = [
    ...itemIds.map(id => `i${id}: item(id:${id}){id name}`),
    ...enchantIds.map(id => `e${id}: enchant(id:${id}){id name}`),
  ].join(' ');
  return `query{gameData{${fields}}}`;
}

/**
 * Build a batched `gameData { ... }` query that resolves spell icon + name by ID in
 * one round-trip. Aliases are prefixed `a` (bare numeric identifiers are not valid
 * GraphQL field names). `gameData.ability(id)` resolves any REAL spell id - including
 * passives a report's `masterData.abilities` omits - but returns `null` for a
 * nonexistent id, so a bad (e.g. mistyped rulebook) id resolves to null rather than a
 * wrong icon; `abilityIcons` skips nulls.
 */
export function buildAbilityIconsQuery(ids: number[]): string {
  const fields = ids.map(id => `a${id}: ability(id:${id}){id name icon}`).join(' ');
  return `query{gameData{${fields}}}`;
}
