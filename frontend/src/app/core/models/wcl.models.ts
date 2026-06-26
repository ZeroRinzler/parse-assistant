export interface WclFight {
  id: number;
  name: string;
  startTime: number;
  endTime: number;
  kill: boolean;
  encounterID: number;
  attempt: number;
  duration_s: number;
  friendlyPlayers: number[];
}

export interface WclPlayer {
  id: number;
  name: string;
  spec: string;
  server: string;
}

export interface WclAbility {
  gameID: number;
  name: string;
  icon: string;
}

/** A single combat-log event row as returned by WCL's `events` query. */
export interface WclEvent {
  type: string;
  timestamp: number;
  abilityGameID: number;
  amount?: number;
  absorbed?: number;
  sourceID?: number;
  targetID?: number;
  // Position is present only when the events query is made with
  // `includeResources: true`. WCL flattens one actor's resource snapshot onto
  // the event; `resourceActor` says whose it is (1 = source, 2 = target).
  // Coordinates are in hundredths of a yard, facing in milliradians.
  resourceActor?: number;
  x?: number;
  y?: number;
  facing?: number;
  mapID?: number;
}

export interface WclReport {
  title: string;
  fights: WclFight[];
  masterData: {
    actors: Array<{ id: number; name: string; subType: string; server: string }>;
    enemies?: Array<{ id: number; name: string; gameID: number }>;
    abilities: WclAbility[];
  };
}

export interface CharacterInfo {
  name: string;
  spec: string | null;
  server: string;
  region: string;
  source_report: string | null;
}

export interface CharacterGear {
  found: boolean;
  spec?: string;
  source_report?: string | null;
  talent_key?: string;
  trinkets?: Array<{ slot: number; id: number; name: string; icon?: string }>;
  enchants?: Array<{ slot: number; id: number; name: string }>;
  message?: string;
}
