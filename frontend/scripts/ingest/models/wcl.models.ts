/**
 * WCL API response shapes and ingest-local aggregation types.
 *
 * Used across the Extract layer (wcl-client / wcl-queries / wcl-mappers /
 * wcl-fetchers) and consumed read-only by the Transform layer (analysis/**).
 * These describe what the WCL v2 API returns and the intermediate shapes the
 * ingestion pipeline passes around - not the on-disk file format (that lives in
 * parse-sample.models.ts / bench.models.ts).
 */

import type { WclGearItem } from '../../../src/app/core/services/wcl-mappers.ts';

export interface WclRateLimitData {
  limitPerHour?: number;
  pointsSpentThisHour?: number;
  pointsResetIn?: number | null;
}

export interface WclPartition { id: number; name: string; }
// `frozen` is true once a zone's rankings are permanently locked - WCL flips it on
// superseded tiers and aggregate/"complete raid" pseudo-zones. The live current tier
// is `frozen: false`. Optional so an absent field is treated as not-frozen (keep).
export interface WclZone { id: number; name: string; frozen?: boolean; partitions?: WclPartition[]; encounters?: Array<{ id: number; name: string }>; }
export interface WclExpansion { id: number; name: string; zones?: WclZone[]; }

export interface WclServerRef { id?: number; name?: string; region?: { slug?: string }; }
export interface WclReportRef { code?: string; fightID?: number; }

export interface WclRawRanking {
  name?: string;
  amount?: number;
  duration?: number;
  server?: WclServerRef;
  report?: WclReportRef;
  gear?: WclGearItem[];
}

export interface WclFightEntry { id: number; startTime: number; endTime: number; encounterID: number; }
export interface WclActorEntry { id: number; name: string; type: string; subType?: string; gameID?: number | null; }

// Event from WCL (may include position fields when includeResources: true).
export interface WclResourceEvent {
  type: string;
  timestamp: number;
  abilityGameID?: number;
  amount?: number;
  absorbed?: number;
  sourceID?: number;
  targetID?: number;
  resourceActor?: number;
  x?: number;
  y?: number;
  facing?: number;
  mapID?: number;
  maxHitPoints?: number;
}

// CombatantInfo event shape.
export interface WclCombatantInfoEvent {
  type: string;
  timestamp: number;
  sourceID?: number;
  talentTree?: Array<{ id?: number; rank?: number; nodeID?: number }>;
}

// Processed ranking entry (one top-parse row), with the raw response kept on
// `_raw` so enrichment can extract gear later without a second query.
export interface ParseRanking {
  rank: number;
  player: string;
  amount: number;
  duration_s: number;
  report_code: string;
  fight_id: number;
  server: string;
  _raw: WclRawRanking;
}

export interface EnrichedRanking {
  server_slug: string;
  server_region: string;
  combatant_info: {
    talent_key: string;
    trinkets: Array<{ slot: number; id: number | string; name: string }>;
    enchants: Array<{ slot: number; id: number | string; name: string }>;
  };
}

export interface IngestEncounter {
  id: number;
  name: string;
  zone: string;
  zoneId: number;
  expansion: string;
  partitionIds: number[];
}

// Fully-fetched per-parse event payload handed to the (pure) analyzer.
export interface ParseEventBundle {
  report_code: string;
  fight_id: number;
  player: WclActorEntry;
  npcById: Map<number, WclActorEntry>;
  // id -> WCL ability name, from the report's masterData.abilities. Bridges the
  // damage-id and cast-id spaces when attributing burst-window cast counts.
  abilityNames: Map<number, string>;
  start: number;
  end: number;
  fightDurS: number;
  castEvents: WclResourceEvent[];
  buffEvents: WclResourceEvent[];
  damageEvents: WclResourceEvent[];
  damageTakenEvents: WclResourceEvent[];
  enemyCastEvents: WclResourceEvent[];
  combatantEvents: WclCombatantInfoEvent[];
  bossDamageEvents: WclResourceEvent[];
}
