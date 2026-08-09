// Everything the runtime also reads (events, rankings, reports, gear) lives in `core/models/wcl.models.ts`.

export interface WclRateLimitData {
  limitPerHour?: number;
  pointsSpentThisHour?: number;
  pointsResetIn?: number | null;
}

export interface WclPartition { id: number; name: string; }
// `frozen` is optional so an absent field is treated as not-frozen (the live current tier).
export interface WclZone { id: number; name: string; frozen?: boolean; partitions?: WclPartition[]; encounters?: { id: number; name: string }[]; }
export interface WclExpansion { id: number; name: string; zones?: WclZone[]; }

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
