/** Internal type. DO NOT USE DIRECTLY. */
type Exact<T extends { [key: string]: unknown }> = { [K in keyof T]: T[K] };
/** Internal type. DO NOT USE DIRECTLY. */
export type Incremental<T> = T | { [P in keyof T]?: P extends ' $fragmentName' | '__typename' ? T[P] : never };
import { WclEventData, PlayerDetailsBlob, WclRankingsBlob, WclTableBlob } from './wcl.models';
export type EventDataType =
  | 'All'
  | 'Buffs'
  | 'Casts'
  | 'CombatantInfo'
  | 'DamageDone'
  | 'DamageTaken'
  | 'Deaths'
  | 'Debuffs'
  | 'Dispels'
  | 'Healing'
  | 'Interrupts'
  | 'Resources'
  | 'Summons'
  | 'Threat';

export type HostilityType =
  | 'Enemies'
  | 'Friendlies';

export type TableDataType =
  | 'Buffs'
  | 'Casts'
  | 'DamageDone'
  | 'DamageTaken'
  | 'Deaths'
  | 'Debuffs'
  | 'Dispels'
  | 'Healing'
  | 'Interrupts'
  | 'Resources'
  | 'Summary'
  | 'Summons'
  | 'Survivability'
  | 'Threat';

export type ReportQueryVariables = Exact<{
  code: string;
}>;

export type ReportQuery = { reportData: { report: { title: string, startTime: number, fights: Array<{ id: number, name: string, startTime: number, endTime: number, kill: boolean | null, encounterID: number, difficulty: number | null, friendlyPlayers: Array<number | null> | null, fightPercentage: number | null } | null> | null, masterData: { actors: Array<{ id: number | null, name: string | null, subType: string | null, server: string | null } | null> | null, enemies: Array<{ id: number | null, name: string | null, gameID: number | null } | null> | null, abilities: Array<{ gameID: number | null, name: string | null, icon: string | null } | null> | null } | null } | null } | null };

export type ReportFightsQueryVariables = Exact<{
  code: string;
}>;

export type ReportFightsQuery = { reportData: { report: { fights: Array<{ id: number, name: string, startTime: number, endTime: number, kill: boolean | null, encounterID: number, difficulty: number | null, friendlyPlayers: Array<number | null> | null, fightPercentage: number | null } | null> | null } | null } | null };

export type PlayerDetailsQueryVariables = Exact<{
  code: string;
  fightIDs: Array<number | null | undefined> | number;
}>;

export type PlayerDetailsQuery = { reportData: { report: { playerDetails: PlayerDetailsBlob | null } | null } | null };

export type EventsQueryVariables = Exact<{
  code: string;
  fightIDs: Array<number | null | undefined> | number;
  dataType?: EventDataType | null | undefined;
  sourceID?: number | null | undefined;
  startTime?: number | null | undefined;
  endTime?: number | null | undefined;
  includeResources?: boolean | null | undefined;
  hostilityType?: HostilityType | null | undefined;
}>;

export type EventsQuery = { reportData: { report: { events: { data: WclEventData | null, nextPageTimestamp: number | null } | null } | null } | null };

export type TableQueryVariables = Exact<{
  code: string;
  fightIDs: Array<number | null | undefined> | number;
  dataType?: TableDataType | null | undefined;
}>;

export type TableQuery = { reportData: { report: { table: WclTableBlob | null } | null } | null };

export type ResurrectsQueryVariables = Exact<{
  code: string;
  fightIDs: Array<number | null | undefined> | number;
  filter?: string | null | undefined;
  startTime?: number | null | undefined;
  endTime?: number | null | undefined;
}>;

export type ResurrectsQuery = { reportData: { report: { events: { data: WclEventData | null, nextPageTimestamp: number | null } | null } | null } | null };

export type RankingsQueryVariables = Exact<{
  encounterID: number;
  className: string;
  specName: string;
  partition?: number | null | undefined;
  difficulty: number;
}>;

export type RankingsQuery = { worldData: { encounter: { characterRankings: WclRankingsBlob | null } | null } | null };

export type CombatantInfoQueryVariables = Exact<{
  code: string;
  fightIDs: Array<number | null | undefined> | number;
  sourceID?: number | null | undefined;
}>;

export type CombatantInfoQuery = { reportData: { report: { events: { data: WclEventData | null } | null } | null } | null };

export type RateLimitQueryVariables = Exact<{ [key: string]: never; }>;

export type RateLimitQuery = { rateLimitData: { limitPerHour: number, pointsSpentThisHour: number } | null };

export type ClassesQueryVariables = Exact<{ [key: string]: never; }>;

export type ClassesQuery = { gameData: { classes: Array<{ name: string, slug: string, specs: Array<{ name: string, slug: string } | null> | null } | null> | null } | null };

export type EncountersQueryVariables = Exact<{ [key: string]: never; }>;

export type EncountersQuery = { worldData: { expansions: Array<{ zones: Array<{ id: number, name: string, frozen: boolean, partitions: Array<{ id: number } | null> | null, encounters: Array<{ id: number, name: string } | null> | null } | null> | null } | null> | null } | null };
