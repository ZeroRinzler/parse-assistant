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
export interface ReportAbilitiesQueryVars { code: string }
export interface PlayerDetailsQueryVars { code: string; fightIDs: number[] }
export interface FightsQueryVars { code: string }
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
export interface CharQueryVars { name: string; serverSlug: string; serverRegion: string }
export interface CombatantInfoQueryVars { code: string; fightIDs: number[]; sourceID: number }

// ---------------------------------------------------------------------------
// Query strings
// ---------------------------------------------------------------------------

export const REPORT_Q = `
query($code:String!){reportData{report(code:$code){
  title
  fights(killType:All){id name startTime endTime kill encounterID difficulty friendlyPlayers}
  masterData{
    actors(type:"Player"){id name subType server}
    enemies:actors(type:"NPC"){id name gameID}
    abilities{gameID name icon}
  }
}}}`;

export const REPORT_ABILITIES_Q = `
query($code:String!){reportData{report(code:$code){masterData{abilities{gameID name icon}}}}}`;

export const PLAYER_DETAILS_Q = `
query($code:String!,$fightIDs:[Int]!){
  reportData{report(code:$code){playerDetails(fightIDs:$fightIDs)}}
}`;

export const FIGHTS_Q = `
query($code:String!){reportData{report(code:$code){fights(killType:All){id}}}}`;

export const EVENTS_Q = `
query($code:String!,$fightIDs:[Int]!,$dataType:EventDataType,$sourceID:Int,$startTime:Float,$endTime:Float,$includeResources:Boolean,$hostilityType:HostilityType){
  reportData{report(code:$code){
    events(fightIDs:$fightIDs,dataType:$dataType,sourceID:$sourceID,
           startTime:$startTime,endTime:$endTime,includeResources:$includeResources,hostilityType:$hostilityType,limit:10000){data nextPageTimestamp}
  }}
}`;

export const USER_CHARS_Q = `{userData{currentUser{characters{id name server{slug region{slug}}}}}}`;

export const CHAR_Q = `
query($name:String!,$serverSlug:String!,$serverRegion:String!){
  characterData{character(name:$name,serverSlug:$serverSlug,serverRegion:$serverRegion){
    name classID
    recentReports(limit:5){data{code startTime}}
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
