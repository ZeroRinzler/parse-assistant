/**
 * WCL response shapes only the ingest discovery layer reads (wcl-client / wcl-mappers /
 * wcl-fetchers): the rate-limit budget, the worldData expansion tree, and the
 * gameData.classes spec universe. Everything the runtime also reads (events, rankings,
 * reports, gear) lives in `core/models/wcl.models.ts`.
 */

export interface WclRateLimitData {
  limitPerHour?: number;
  pointsSpentThisHour?: number;
  pointsResetIn?: number | null;
}

export interface WclPartition { id: number; name: string; }
// `frozen` is true once a zone's rankings are permanently locked - WCL flips it on
// superseded tiers and aggregate/"complete raid" pseudo-zones. The live current tier
// is `frozen: false`. Optional so an absent field is treated as not-frozen (keep).
export interface WclZone { id: number; name: string; frozen?: boolean; partitions?: WclPartition[]; encounters?: { id: number; name: string }[]; }
export interface WclExpansion { id: number; name: string; zones?: WclZone[]; }

/** A WCL `gameData.classes` entry: the spec universe (class + its specs, with slugs). */
export interface WclGameSpec { id: number; name: string; slug: string; }
export interface WclGameClass { id: number; name: string; slug: string; specs?: WclGameSpec[]; }

export interface IngestEncounter {
  id: number;
  name: string;
  zone: string;
  zoneId: number;
  expansion: string;
  partitionIds: number[];
}
