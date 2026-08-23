import { describe, it, expect } from 'vitest';
import { getEncounters } from './wcl-fetchers';
import type { WclQueryClient } from './wcl-client';

const ABYSS = 53, SPOREFALL = 50;

const expansions = [{
  id: 7, name: 'Midnight', zones: [
    { id: 46, name: 'VS / DR / MQD', frozen: false, encounters: [{ id: 3176, name: 'Imperator' }] },
    { id: SPOREFALL, name: 'Sporefall', frozen: false, partitions: [{ id: 2 }, { id: 1 }], encounters: [{ id: 3159, name: 'Rotmire' }] },
    { id: ABYSS, name: 'The Venomous Abyss', frozen: false, encounters: [{ id: 3470, name: "Nek'zali" }, { id: 3445, name: 'Sentinels' }] },
    { id: 54, name: 'The Venomous Abyss', frozen: true, encounters: [{ id: 3480, name: 'Frozen copy' }] },
  ],
}];

function fakeClient(response: unknown = { worldData: { expansions } }): WclQueryClient {
  return {
    async query() { return response as never; },
    async assertBudget() { /* no-op */ },
  };
}

describe('getEncounters', () => {
  it('returns the named raids\' encounters, in the order they were named', async () => {
    const { encounters } = await getEncounters(fakeClient(), ['The Venomous Abyss', 'Sporefall']);
    expect(encounters.map(encounter => encounter.id)).toEqual([3470, 3445, 3159]);
    expect(encounters[0]).toMatchObject({ zone: 'The Venomous Abyss', zoneId: ABYSS });
    expect(encounters[2]).toMatchObject({ zone: 'Sporefall', zoneId: SPOREFALL, partitionIds: [2, 1] });
  });

  it('protects exactly the named raids, so everything else on disk is pruned', async () => {
    const { protectedIds } = await getEncounters(fakeClient(), ['The Venomous Abyss']);
    expect([...protectedIds].sort((a, b) => a - b)).toEqual([3445, 3470]);
  });

  it('protects nothing when no raid is named, which is what stops an unset variable pruning the dataset', async () => {
    const { encounters, protectedIds } = await getEncounters(fakeClient(), []);
    expect(encounters).toEqual([]);
    expect(protectedIds.size).toBe(0);
  });

  it('throws rather than pruning everything when WCL returns no expansions', async () => {
    await expect(getEncounters(fakeClient({ worldData: {} }), ['The Venomous Abyss'])).rejects.toThrow('worldData.expansions');
  });
});
