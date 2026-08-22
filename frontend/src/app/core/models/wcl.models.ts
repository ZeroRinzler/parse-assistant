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
  /** Boss health % remaining when the pull ended (WCL `fightPercentage`); ~0 on a kill. */
  fightPercentage: number;
  /** WCL difficulty id: 3/4/5 are raid normal/heroic/mythic, 10 a Mythic+ dungeon boss. */
  difficulty?: number | null;
}

/** The only difficulty the app analyzes and benches. */
export const MYTHIC_DIFFICULTY = 5;

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

export interface WclEvent {
  type: string;
  timestamp: number;
  abilityGameID: number;
  amount?: number;
  absorbed?: number;
  sourceID?: number;
  targetID?: number;
  // Copies of one NPC share a targetID and differ only here, so enemy counts must key on both.
  targetInstance?: number;
  // Present on `death` events: `amount` is absent, so the lethal hit's magnitude is read from the matching DamageTaken event.
  killingAbilityGameID?: number;
  // Position is present only when the events query is made with `includeResources: true`; `resourceActor` says whose snapshot it is (1 = source, 2 = target).
  resourceActor?: number;
  x?: number;
  y?: number;
  facing?: number;
  mapID?: number;
  // Used to pick the boss (highest observed maxHitPoints) when building position benches.
  maxHitPoints?: number;
  // Flattened onto the event by `includeResources: true`, alongside maxHitPoints.
  hitPoints?: number;
  // Present on applybuffstack / removebuffstack / applydebuffstack / removedebuffstack: the new total, a bare apply being an implicit 1.
  stack?: number;
  // Flattened onto the event by `includeResources: true`; `type` is WCL's power-type id (4 = combo points) and `amount` is the pool BEFORE `cost` is deducted.
  classResources?: { amount: number; max?: number; type: number; cost?: number }[];
}

export interface WclReport {
  title: string;
  /** Unix epoch ms of the report's first logged event; the shared clock for clip correlation. */
  startTime: number;
  fights: WclFight[];
  masterData?: {
    actors: { id: number; name: string; subType: string; server: string }[];
    enemies?: { id: number; name: string; gameID: number }[];
    abilities: WclAbility[];
  };
}

/** A mapped top parse: which report + fight + player to refetch (from rankings). */
export interface ParseRanking {
  player: string;
  server: string;
  report_code: string;
  fight_id: number;
}

export interface WclGearItem {
  id?: number | string;
  name?: string;
  icon?: string;
  permanentEnchant?: number | string;
  permanentEnchantName?: string;
}

/** `id` is the talent entry, never a spell id. */
export interface WclTalentNode {
  nodeID?: number;
  id?: number;
  rank?: number;
}

export interface WclCombatantInfo {
  sourceID?: number;
  gear?: WclGearItem[];
  talentTree?: WclTalentNode[];
}

// CombatantInfo rows come back through the same `events.data` field as ordinary events, so one type has to cover both.
export type WclEventData = (WclEvent & WclCombatantInfo)[];

/** One `playerDetails` role entry (dps / healers / tanks / unknown). */
interface PlayerDetailEntry {
  id: number;
  type: string;
  name: string;
  specs?: { spec: string }[];
}
export type PlayerDetailGroups = Record<string, PlayerDetailEntry[]>;

export interface PlayerDetailsBlob { data?: { playerDetails?: PlayerDetailGroups } }

export interface WclRawRanking {
  name?: string;
  server?: { name?: string };
  report?: { code?: string; fightID?: number };
}

// Either a JSON blob (string) or an already-parsed object; consumers unwrap both forms (see `unwrapRankings`).
export type WclRankingsBlob = string | { rankings?: WclRawRanking[] };

// Either a JSON blob (string) or an already-parsed object; `data.entries` carries one row per source actor (`id` = actor id, `total` = summed damage).
export type WclTableBlob = string | { data?: { entries?: { id: number; total: number }[] } };

// WCL returns `null` for an id it cannot resolve, so the batched map is `entry | null` per alias.
export interface WclRawAbility {
  id: number;
  name: string;
  icon: string | null;
}

export interface CharacterGear {
  talent_key?: string;
  trinkets?: { slot: number; id: number; name: string; icon?: string }[];
  enchants?: { slot: number; id: number; name: string }[];
}
