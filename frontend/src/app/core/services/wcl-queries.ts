// Untagging one of these documents silently drops it from the generated types.
const gql = (document: TemplateStringsArray): string => document.join('');

export const REPORT_Q = gql`
query Report($code:String!){reportData{report(code:$code){
  title
  startTime
  fights(killType:All){id name startTime endTime kill encounterID difficulty friendlyPlayers fightPercentage}
  masterData{
    actors(type:"Player"){id name subType server}
    enemies:actors(type:"NPC"){id name gameID}
    abilities{gameID name icon}
  }
}}}`;

export const REPORT_FIGHTS_Q = gql`
query ReportFights($code:String!){reportData{report(code:$code){
  fights(killType:All){id name startTime endTime kill encounterID difficulty friendlyPlayers fightPercentage}
}}}`;

export const PLAYER_DETAILS_Q = gql`
query PlayerDetails($code:String!,$fightIDs:[Int]!){
  reportData{report(code:$code){playerDetails(fightIDs:$fightIDs)}}
}`;

export const EVENTS_Q = gql`
query Events($code:String!,$fightIDs:[Int]!,$dataType:EventDataType,$sourceID:Int,$startTime:Float,$endTime:Float,$includeResources:Boolean,$hostilityType:HostilityType){
  reportData{report(code:$code){
    events(fightIDs:$fightIDs,dataType:$dataType,sourceID:$sourceID,
           startTime:$startTime,endTime:$endTime,includeResources:$includeResources,hostilityType:$hostilityType,limit:10000){data nextPageTimestamp}
  }}
}`;

// The whole pull's table (no source filter), because filtering by `sourceID` regroups the rows by ability rather than by player.
export const TABLE_Q = gql`
query Table($code:String!,$fightIDs:[Int]!,$dataType:TableDataType){
  reportData{report(code:$code){table(fightIDs:$fightIDs,dataType:$dataType)}}
}`;

// WCL has no `Resurrects` data type, so this scans `All` with a server-side `filterExpression` (only the matching events come back).
export const RESURRECTS_Q = gql`
query Resurrects($code:String!,$fightIDs:[Int]!,$filter:String,$startTime:Float,$endTime:Float){
  reportData{report(code:$code){
    events(fightIDs:$fightIDs,dataType:All,filterExpression:$filter,startTime:$startTime,endTime:$endTime,limit:10000){data nextPageTimestamp}
  }}
}`;

// `$partition` is nullable: absent selects WCL's current partition (what the runtime always wants); the ingest liveness probe passes explicit partitions newest-first. An absent `$difficulty` would make WCL substitute the zone's top difficulty.
export const RANKINGS_Q = gql`
query Rankings($encounterID:Int!,$className:String!,$specName:String!,$partition:Int,$difficulty:Int!){
  worldData{encounter(id:$encounterID){
    characterRankings(className:$className,specName:$specName,metric:dps,partition:$partition,difficulty:$difficulty)
  }}
}`;

export const COMBATANT_INFO_Q = gql`
query CombatantInfo($code:String!,$fightIDs:[Int]!,$sourceID:Int){
  reportData{report(code:$code){
    events(fightIDs:$fightIDs,dataType:CombatantInfo,sourceID:$sourceID){data}
  }}
}`;

// Item aliases are prefixed `i`, enchant aliases `e` (bare numeric identifiers are not valid GraphQL field names).
export function buildGearNamesQuery(itemIds: number[], enchantIds: number[]): string {
  const fields = [
    ...itemIds.map(id => `i${id}: item(id:${id}){id name}`),
    ...enchantIds.map(id => `e${id}: enchant(id:${id}){id name}`),
  ].join(' ');
  return `query{gameData{${fields}}}`;
}

// `gameData.ability(id)` returns `null` for a nonexistent id, so a bad (e.g. mistyped rulebook) id resolves to null rather than a wrong icon.
export function buildAbilityIconsQuery(ids: number[]): string {
  const fields = ids.map(id => `a${id}: ability(id:${id}){id name icon}`).join(' ');
  return `query{gameData{${fields}}}`;
}

// The discovery reads' queries, issued only during ingestion.

/** The WCL hourly point budget - the ingest orchestrator's budget gate. */
export const RATE_LIMIT_Q = gql`query RateLimit { rateLimitData { limitPerHour pointsSpentThisHour } }`;

// `class.slug`/`spec.slug` are the exact `className`/`specName` the rankings query takes; the folder key is `spec.slug + class.slug`.
export const CLASSES_Q = gql`query Classes { gameData { classes { name slug specs { name slug } } } }`;

/** The worldData expansion tree the current-raid discovery filters. */
export const ENCOUNTERS_Q = gql`
query Encounters {
  worldData {
    expansions {
      zones {
        id name frozen
        partitions { id }
        encounters { id name }
      }
    }
  }
}`;
