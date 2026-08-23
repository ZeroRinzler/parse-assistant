// Everything the runtime also reads (events, rankings, reports, gear) lives in `core/models/wcl.models.ts`.

export interface IngestEncounter {
  id: number;
  name: string;
  zone: string;
  zoneId: number;
  partitionIds: number[];
}
