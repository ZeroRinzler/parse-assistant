import { describe, it, expect } from 'vitest';
import { getEncounters, getRankingsLite, enrichRanking, getParseEvents, getEnchantNames } from './wcl-fetchers.ts';
import { Events } from './testing/events.ts';
import { SHADOW_BLADES } from './testing/spell-ids.ts';
import type { WclQueryClient, EventFetchOptions } from './wcl-client.ts';
import type { WclResourceEvent, ParseRanking } from './models/wcl.models.ts';

interface FakeHandlers {
  query?: (gql: string, vars?: object) => unknown;
  getAllEvents?: (dataType: string, options: EventFetchOptions) => WclResourceEvent[];
  resolveServerSlug?: (id: number) => [string, string];
}

function fakeClient(handlers: FakeHandlers): WclQueryClient {
  return {
    async query(gql: string, vars?: object) { return (handlers.query?.(gql, vars) ?? {}) as never; },
    async getAllEvents(_code: string, _fightId: number, dataType: string, _start: number, _end: number, options: EventFetchOptions = {}) {
      return handlers.getAllEvents?.(dataType, options) ?? [];
    },
    async resolveServerSlug(id: number) { return handlers.resolveServerSlug?.(id) ?? ['', '']; },
  } as WclQueryClient;
}

describe('getEncounters', () => {
  it('maps the expansions blob through filterEncounters', async () => {
    const client = fakeClient({
      query: () => ({ worldData: { expansions: [{ id: 1, name: 'Current', zones: [{ id: 10, name: 'Raid', partitions: [{ id: 2, name: 'p' }], encounters: [{ id: 100, name: 'Boss' }] }] }] } }),
    });
    const encounters = await getEncounters(client);
    expect(encounters).toHaveLength(1);
    expect(encounters[0]).toMatchObject({ id: 100, partitionIds: [2] });
  });
});

describe('getRankingsLite', () => {
  it('throws on an unknown spec', async () => {
    await expect(getRankingsLite(fakeClient({}), 'NotASpec', 100, 10, [])).rejects.toThrow('Unknown spec');
  });

  it('tries partitions newest-first and falls back when one is empty', async () => {
    const client = fakeClient({
      query: (_gql, vars) => {
        const partition = (vars as { partition?: number }).partition;
        const rankings = partition === 3 ? [] : [{ name: 'A', amount: 10, duration: 1000, report: { code: 'r1', fightID: 1 } }];
        return { worldData: { encounter: { name: 'Boss', characterRankings: { rankings } } } };
      },
    });
    const ranked = await getRankingsLite(client, 'SubtletyRogue', 100, 10, [3, 2]);
    expect(ranked).toHaveLength(1);
    expect(ranked[0].player).toBe('A');
  });

  it('parses characterRankings when returned as a JSON string', async () => {
    const client = fakeClient({
      query: () => ({ worldData: { encounter: { name: 'Boss', characterRankings: JSON.stringify({ rankings: [{ name: 'A', report: { code: 'r', fightID: 1 } }] }) } } }),
    });
    const ranked = await getRankingsLite(client, 'SubtletyRogue', 100, 10, []);
    expect(ranked[0].player).toBe('A');
  });
});

describe('enrichRanking', () => {
  it('resolves the server slug and extracts gear', async () => {
    const client = fakeClient({ resolveServerSlug: () => ['area-52', 'us'] });
    const ranking = { _raw: { server: { id: 5 }, gear: [] } } as unknown as ParseRanking;
    const enriched = await enrichRanking(client, ranking);
    expect(enriched.server_slug).toBe('area-52');
    expect(enriched.server_region).toBe('us');
    expect(enriched.combatant_info.talent_key).toBe('');
  });
});

describe('getParseEvents', () => {
  const actors = [
    { id: 1, name: 'Tester', type: 'Player' },
    { id: 2, name: 'Boss', type: 'NPC', gameID: 5000 },
  ];
  const meta = (fights: object[]) => ({ reportData: { report: { fights, masterData: { actors } } } });

  it('returns null when the fight is not in the report', async () => {
    const client = fakeClient({ query: () => meta([]) });
    expect(await getParseEvents(client, 'rep', 1, 'Tester')).toBeNull();
  });

  it('throws when the player is absent from a present fight', async () => {
    const client = fakeClient({ query: () => meta([{ id: 1, startTime: 0, endTime: 1000, encounterID: 5 }]) });
    await expect(getParseEvents(client, 'rep', 1, 'Ghost')).rejects.toThrow('not found');
  });

  it('assembles the bundle and fetches boss damage once a boss is detected', async () => {
    const enemyCasts = Events.start().position(2, '0:01', 0, 0, { maxHp: 1000 }).build();
    const client = fakeClient({
      query: () => meta([{ id: 1, startTime: 0, endTime: 60_000, encounterID: 5 }]),
      getAllEvents: (dataType, options) => {
        if (dataType === 'Casts' && options.hostilityType === 'Enemies') return enemyCasts;
        if (dataType === 'Casts') return Events.cast(SHADOW_BLADES, '0:05').build();
        if (dataType === 'DamageDone' && options.sourceId === 2) return enemyCasts; // boss damage stream (non-empty)
        return [];
      },
    });

    const bundle = await getParseEvents(client, 'rep', 1, 'Tester');
    expect(bundle).not.toBeNull();
    expect(bundle!.player.id).toBe(1);
    expect(bundle!.fightDurS).toBe(60);
    expect(bundle!.castEvents).toHaveLength(1);
    expect(bundle!.bossDamageEvents.length).toBeGreaterThan(0);
    expect(bundle!.npcById.get(2)?.gameID).toBe(5000);
  });
});

describe('getEnchantNames', () => {
  it('resolves names and skips the query entirely for no ids', async () => {
    const client = fakeClient({ query: () => ({ gameData: { e200: { id: 200, name: 'Enchant A' } } }) });
    const names = await getEnchantNames(client, [200]);
    expect(names.get(200)).toBe('Enchant A');
    expect(await getEnchantNames(client, [])).toEqual(new Map());
  });
});
