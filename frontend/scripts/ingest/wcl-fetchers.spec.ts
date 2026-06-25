import { describe, it, expect } from 'vitest';
import { getEncounters, getRankingsLite, enrichRanking, getParseEvents, getEnchantNames } from './wcl-fetchers.ts';
import { Events } from './testing/events.ts';
import { SHADOW_BLADES } from './testing/spell-ids.ts';
import { BudgetExceededError } from './wcl-client.ts';
import type { WclQueryClient, EventFetchOptions } from './wcl-client.ts';
import type { WclResourceEvent, ParseRanking, WclRawRanking } from './models/wcl.models.ts';

interface FakeHandlers {
  query?: (gql: string, vars?: object) => unknown;
  getAllEvents?: (dataType: string, options: EventFetchOptions) => WclResourceEvent[];
  resolveServerSlug?: (id: number) => [string, string];
  assertBudget?: (margin: number) => void;
}

function fakeClient(handlers: FakeHandlers): WclQueryClient {
  return {
    async query(gql: string, vars?: object) { return (handlers.query?.(gql, vars) ?? {}) as never; },
    async getAllEvents(_code: string, _fightId: number, dataType: string, _start: number, _end: number, options: EventFetchOptions = {}) {
      return handlers.getAllEvents?.(dataType, options) ?? [];
    },
    async resolveServerSlug(id: number) { return handlers.resolveServerSlug?.(id) ?? ['', '']; },
    async assertBudget(margin: number) { handlers.assertBudget?.(margin); },
  } as WclQueryClient;
}

// Build `count` non-anonymous ranking rows (each has a report, so mapRankings keeps it).
const ranks = (count: number): WclRawRanking[] =>
  Array.from({ length: count }, (_unused, index) => ({ name: `P${index}`, report: { code: `r${index}`, fightID: index } }));

describe('getEncounters', () => {
  // Live raids (frozen:false + real rankings) are kept; a frozen tier, a name-excluded
  // Mythic+ zone, and a frozen:false-but-no-rankings test zone are all dropped. Modeled
  // on the real Midnight worldData.
  const expansions = [{
    id: 7, name: 'Midnight', zones: [
      { id: 46, name: 'VS / DR / MQD', frozen: false, encounters: [{ id: 3176, name: 'Imperator' }, { id: 3177, name: 'Vorasius' }] },
      { id: 50, name: 'Sporefall', frozen: false, encounters: [{ id: 3159, name: 'Rotmire' }] },
      { id: 52, name: 'Dummy Dome', frozen: false, encounters: [{ id: 3591, name: 'Sinister Single' }] },
      { id: 53, name: 'The Venomous Abyss', frozen: true, encounters: [{ id: 3470, name: 'Old' }] },
      { id: 47, name: 'Mythic+ Season 1', frozen: false, encounters: [{ id: 112526, name: 'Dungeon' }] },
    ],
  }];

  // rankings per encounter id: live bosses return 10, the test boss returns none.
  const rankingsByEncounter: Record<number, number> = { 3176: 10, 3177: 10, 3159: 10, 3591: 0 };

  function contentClient(overrides: Partial<FakeHandlers> = {}, probeCounter?: { count: number }): WclQueryClient {
    return fakeClient({
      query: (gql, vars) => {
        if (gql.includes('expansions')) return { worldData: { expansions } };
        // RANKINGS_QUERY probe
        if (probeCounter) probeCounter.count++;
        const encounterID = (vars as { encounterID: number }).encounterID;
        return { worldData: { encounter: { name: 'Boss', characterRankings: { rankings: ranks(rankingsByEncounter[encounterID] ?? 0) } } } };
      },
      ...overrides,
    });
  }

  it('keeps live zones, drops frozen / name-excluded / no-ranking zones', async () => {
    const { encounters, protectedIds } = await getEncounters(contentClient());
    expect(encounters.map(encounter => encounter.id).sort((a, b) => a - b)).toEqual([3159, 3176, 3177]);
    // protected set = all non-frozen ids (includes the name-excluded M+ and test zone), excludes the frozen tier.
    expect([...protectedIds].sort((a, b) => a - b)).toEqual([3159, 3176, 3177, 3591, 112526]);
  });

  it('probes per zone (once per live zone via early-exit), not per spec', async () => {
    const probeCounter = { count: 0 };
    await getEncounters(contentClient({}, probeCounter));
    // zone 46 + zone 50 early-exit after 1 spec each (1 + 1); zone 52 has no rankings so all 3 probe specs run (3). Total 5.
    expect(probeCounter.count).toBe(5);
  });

  it('propagates a BudgetExceededError raised while probing', async () => {
    const client = contentClient({ assertBudget: () => { throw new BudgetExceededError('low'); } });
    await expect(getEncounters(client)).rejects.toThrow(BudgetExceededError);
  });

  it('drops a zone whose only parses are privacy-anonymized (the "Dummy Dome" case)', async () => {
    const anonymized: WclRawRanking[] = Array.from({ length: 8 }, (_unused, index) => ({
      name: `Character 13600${index}-1163300${index}`, report: { code: `r${index}`, fightID: index },
    }));
    const client = fakeClient({
      query: (gql) => {
        if (gql.includes('expansions')) {
          return { worldData: { expansions: [{ id: 7, name: 'Midnight', zones: [{ id: 52, name: 'Dummy Dome', frozen: false, encounters: [{ id: 3591, name: 'Sinister Single' }] }] }] } };
        }
        return { worldData: { encounter: { name: 'Sinister Single', characterRankings: { rankings: anonymized } } } };
      },
    });
    const { encounters } = await getEncounters(client);
    expect(encounters).toHaveLength(0);
  });

  it('drops a zone whose probe stays below the liveness threshold', async () => {
    const client = fakeClient({
      query: (gql, vars) => {
        if (gql.includes('expansions')) {
          return { worldData: { expansions: [{ id: 7, name: 'Midnight', zones: [{ id: 60, name: 'Thin Raid', frozen: false, encounters: [{ id: 9001, name: 'Boss' }] }] }] } };
        }
        // Only the first probe spec (Mage) returns parses, and just 2 - below the threshold of 3.
        const className = (vars as { className: string }).className;
        return { worldData: { encounter: { name: 'Boss', characterRankings: { rankings: className === 'Mage' ? ranks(2) : [] } } } };
      },
    });
    const { encounters } = await getEncounters(client);
    expect(encounters).toHaveLength(0);
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
  const abilities = [{ gameID: SHADOW_BLADES, name: 'Shadow Blades' }];
  const meta = (fights: object[]) => ({ reportData: { report: { fights, masterData: { actors, abilities } } } });

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
    expect(bundle!.abilityNames.get(SHADOW_BLADES)).toBe('Shadow Blades');
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
