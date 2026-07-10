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
  // Present on `death` events: the ability that dealt the killing blow (its `amount` is
  // absent, so the lethal hit's magnitude is read from the matching DamageTaken event).
  killingAbilityGameID?: number;
  // Present on DamageTaken events: the full incoming hit before the player's mitigation.
  unmitigatedAmount?: number;
  // Position is present only when the events query is made with
  // `includeResources: true`. WCL flattens one actor's resource snapshot onto
  // the event; `resourceActor` says whose it is (1 = source, 2 = target).
  // Coordinates are in hundredths of a yard, facing in milliradians.
  resourceActor?: number;
  x?: number;
  y?: number;
  facing?: number;
  mapID?: number;
  // Also flattened onto the event by `includeResources: true`; used to pick the
  // boss (highest observed maxHitPoints) when building position benches.
  maxHitPoints?: number;
}

export interface WclReport {
  title: string;
  /** Unix epoch ms of the report's first logged event; the shared clock for clip correlation. */
  startTime: number;
  fights: WclFight[];
  masterData: {
    actors: { id: number; name: string; subType: string; server: string }[];
    enemies?: { id: number; name: string; gameID: number }[];
    abilities: WclAbility[];
  };
}

/** A mapped top parse: which report + fight + player to refetch (from rankings). */
export interface ParseRanking {
  player: string;
  report_code: string;
  fight_id: number;
}

// Raw WCL response shapes (bytes as WCL returns them; consumers map these to
// application models). These belong to the API contract, not the domain model.

/** A single gear array entry from a WCL CombatantInfo / ranking. */
export interface WclGearItem {
  id?: number | string;
  name?: string;
  icon?: string;
  permanentEnchant?: number | string;
  permanentEnchantName?: string;
}

/** A raw CombatantInfo event: gear + talentTree, keyed by sourceID. */
export interface WclCombatantInfo {
  sourceID?: number;
  gear?: WclGearItem[];
  talentTree?: { nodeID?: number }[];
}

/** One `playerDetails` role entry (dps / healers / tanks / unknown). */
export interface PlayerDetailEntry {
  id: number;
  type: string;
  name: string;
  specs?: { spec: string }[];
}
export type PlayerDetailGroups = Record<string, PlayerDetailEntry[]>;

/** One raw `characterRankings` entry (the fields the transforms need). */
export interface WclRawRanking {
  name?: string;
  report?: { code?: string; fightID?: number };
}

/**
 * Raw `characterRankings` envelope as WCL returns it: either a JSON blob (string)
 * or an already-parsed object carrying the `rankings` array. Consumers unwrap both
 * forms (see `unwrapRankings`).
 */
export type WclRankingsBlob = string | { rankings?: WclRawRanking[] };

/**
 * Raw `report.table(dataType:DamageDone)` envelope as WCL returns it: either a JSON
 * blob (string) or an already-parsed object. `data.entries` carries one row per source
 * actor (`id` = actor id, `total` = summed damage). Consumers unwrap both forms.
 */
export type WclTableBlob = string | { data?: { entries?: { id: number; total: number }[] } };

/**
 * One raw `gameData.ability` entry. The `icon` carries the trailing `.jpg` zamimg
 * extension; consumers strip it (see `abilityIcons`). WCL returns `null` for an id
 * it cannot resolve, so the batched map is `entry | null` per alias. It can also
 * resolve `id`/`name` while leaving `icon` null (some passives have no art), so
 * `icon` is nullable and consumers fall back to name-only.
 */
export interface WclRawAbility {
  id: number;
  name: string;
  icon: string | null;
}

export interface CharacterGear {
  found: boolean;
  spec?: string;
  source_report?: string | null;
  talent_key?: string;
  trinkets?: { slot: number; id: number; name: string; icon?: string }[];
  enchants?: { slot: number; id: number; name: string }[];
  message?: string;
}
