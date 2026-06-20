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
export interface CharEncQueryVars { name: string; serverSlug: string; serverRegion: string; encID: number }

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

export const CHAR_ENC_Q = `
query($name:String!,$serverSlug:String!,$serverRegion:String!,$encID:Int!){
  characterData{character(name:$name,serverSlug:$serverSlug,serverRegion:$serverRegion){
    encounterRankings(encounterID:$encID,includeCombatantInfo:true)
  }}
}`;

/**
 * Build a batched `gameData { ... }` query that resolves enchant names by ID.
 * Each alias is prefixed with `e` to produce valid GraphQL field names
 * (numeric-only identifiers are not valid).
 */
export function buildEnchantNamesQuery(enchantIds: number[]): string {
  const fields = enchantIds.map(id => `e${id}: enchant(id:${id}){id name}`).join(' ');
  return `query{gameData{${fields}}}`;
}
