import { ENCOUNTERS_Q } from '../core/services/wcl-queries';
import type { EncountersQuery } from '../core/services/wcl-operations.generated';
import type { WclQueryClient } from './wcl-client';
import { encountersForRaids } from './wcl-mappers';
import type { IngestEncounter } from './models/wcl.models';

export interface CurrentContent {
  encounters: IngestEncounter[];
  protectedIds: Set<number>;
}

export async function getEncounters(client: WclQueryClient, raidNames: string[]): Promise<CurrentContent> {
  const data = await client.query<EncountersQuery>(ENCOUNTERS_Q);
  // An empty expansion tree would resolve no encounter and prune every spec's data.
  if (!data.worldData?.expansions) throw new Error('WCL returned no worldData.expansions.');
  const encounters = encountersForRaids(data.worldData.expansions, raidNames);
  return { encounters, protectedIds: new Set(encounters.map(encounter => encounter.id)) };
}
