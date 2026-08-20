import { assert, describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { getEncounters, getRankingsLite, rankingsFromPartition } from './wcl-fetchers';
import { BudgetExceededError } from './wcl-client';
import type { WclQueryClient } from './wcl-client';
import type { SpecWclMap } from './wcl-mappers';
import { MYTHIC_DIFFICULTY, type WclRawRanking } from '../core/models/wcl.models';

const SPEC_WCL: SpecWclMap = {
  FireMage: ['Mage', 'Fire'],
  RetributionPaladin: ['Paladin', 'Retribution'],
  FuryWarrior: ['Warrior', 'Fury'],
  SubtletyRogue: ['Rogue', 'Subtlety'],
};

const HEROIC_DIFFICULTY = 4;
const NORMAL_DIFFICULTY = 3;

interface FakeHandlers {
  query?: (gql: string, vars?: object) => unknown;
  assertBudget?: (margin: number) => void;
}

function fakeClient(handlers: FakeHandlers): WclQueryClient {
  return {
    async query(gql: string, vars?: object) { return (handlers.query?.(gql, vars) ?? {}) as never; },
    async assertBudget(margin: number) { handlers.assertBudget?.(margin); },
  };
}

// Build `count` non-anonymous ranking rows (each has a report, so toParseRankings keeps it).
const ranks = (count: number): WclRawRanking[] =>
  Array.from({ length: count }, (_unused, index) => ({ name: `P${index}`, report: { code: `r${index}`, fightID: index } }));

describe('getEncounters', () => {
  // The spy keeps the runner output clean and lets the drop tests assert on the warning.
  let warnSpy: MockInstance<typeof console.warn>;
  beforeEach(() => { warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined); });
  afterEach(() => { warnSpy.mockRestore(); });

  // Modeled on the real Midnight worldData.
  const expansions = [{
    id: 7, name: 'Midnight', zones: [
      { id: 46, name: 'VS / DR / MQD', frozen: false, encounters: [{ id: 3176, name: 'Imperator' }, { id: 3177, name: 'Vorasius' }] },
      { id: 50, name: 'Sporefall', frozen: false, encounters: [{ id: 3159, name: 'Rotmire' }] },
      { id: 52, name: 'Dummy Dome', frozen: false, encounters: [{ id: 3591, name: 'Sinister Single' }] },
      { id: 53, name: 'The Venomous Abyss', frozen: true, encounters: [{ id: 3470, name: 'Old' }] },
      { id: 47, name: 'Mythic+ Season 1', frozen: false, encounters: [{ id: 112526, name: 'Dungeon' }] },
    ],
  }];

  const rankingsByEncounter: Record<number, number> = { 3176: 10, 3177: 10, 3159: 10, 3591: 0 };

  function contentClient(overrides: Partial<FakeHandlers> = {}, probeCounter?: { count: number }): WclQueryClient {
    return fakeClient({
      query: (gql, vars) => {
        if (gql.includes('expansions')) return { worldData: { expansions } };
        if (probeCounter) probeCounter.count++;
        const encounterID = (vars as { encounterID: number }).encounterID;
        return { worldData: { encounter: { name: 'Boss', characterRankings: { rankings: ranks(rankingsByEncounter[encounterID] ?? 0) } } } };
      },
      ...overrides,
    });
  }

  it('makes the newest live zone the whole current content, phasing out an older zone that still has rankings', async () => {
    const { encounters, protectedIds } = await getEncounters(contentClient(), SPEC_WCL);
    expect(encounters.map(encounter => encounter.id)).toEqual([3159]);
    // Zones at or above the live zone's id stay protected; the phased-out zone 46 (and the older M+ zone) do not.
    expect([...protectedIds].sort((a, b) => a - b)).toEqual([3159, 3591]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('getEncounters'), expect.stringContaining('Dummy Dome'));
  });

  it('probes newest zone first and stops at the first live one, leaving older zones unqueried', async () => {
    const probeCounter = { count: 0 };
    await getEncounters(contentClient({}, probeCounter), SPEC_WCL);
    // Zone 52 has no rankings, so all 3 probe specs run all 3 difficulties (9); zone 50 early-exits on its first Mythic probe (1); zone 46 is never probed.
    expect(probeCounter.count).toBe(10);
  });

  it('detects a just-opened raid with Heroic parses but no Mythic kills yet', async () => {
    const difficultiesTried: number[] = [];
    const client = fakeClient({
      query: (gql, vars) => {
        if (gql.includes('expansions')) {
          return { worldData: { expansions: [{ id: 7, name: 'Midnight', zones: [{ id: 60, name: 'New Raid', frozen: false, encounters: [{ id: 9100, name: 'First Boss' }] }] }] } };
        }
        const difficulty = (vars as { difficulty: number }).difficulty;
        difficultiesTried.push(difficulty);
        return { worldData: { encounter: { name: 'First Boss', characterRankings: { rankings: difficulty === HEROIC_DIFFICULTY ? ranks(10) : [] } } } };
      },
    });
    const { encounters } = await getEncounters(client, SPEC_WCL);
    expect(encounters.map(encounter => encounter.id)).toEqual([9100]);
    expect(difficultiesTried).toEqual([MYTHIC_DIFFICULTY, HEROIC_DIFFICULTY]);
  });

  it('keeps every candidate protected when no zone at all is live', async () => {
    const client = contentClient({
      query: (gql) => {
        if (gql.includes('expansions')) return { worldData: { expansions } };
        return { worldData: { encounter: { name: 'Boss', characterRankings: { rankings: [] } } } };
      },
    });
    const { encounters, protectedIds } = await getEncounters(client, SPEC_WCL);
    expect(encounters).toHaveLength(0);
    expect([...protectedIds].sort((a, b) => a - b)).toEqual([3159, 3176, 3177, 3591, 112526]);
  });

  it('propagates a BudgetExceededError raised while probing', async () => {
    const client = contentClient({ assertBudget: () => { throw new BudgetExceededError('low'); } });
    await expect(getEncounters(client, SPEC_WCL)).rejects.toThrow(BudgetExceededError);
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
    const { encounters } = await getEncounters(client, SPEC_WCL);
    expect(encounters).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('getEncounters'), expect.stringContaining('Dummy Dome'));
  });

  it('drops a zone whose probe stays below the liveness threshold', async () => {
    const client = fakeClient({
      query: (gql, vars) => {
        if (gql.includes('expansions')) {
          return { worldData: { expansions: [{ id: 7, name: 'Midnight', zones: [{ id: 60, name: 'Thin Raid', frozen: false, encounters: [{ id: 9001, name: 'Boss' }] }] }] } };
        }
        // Only the first probe spec (Mage) returns parses, and just 2 at Mythic alone - below the threshold of 3.
        const className = (vars as { className: string }).className;
        const difficulty = (vars as { difficulty: number }).difficulty;
        const rankings = className === 'Mage' && difficulty === MYTHIC_DIFFICULTY ? ranks(2) : [];
        return { worldData: { encounter: { name: 'Boss', characterRankings: { rankings } } } };
      },
    });
    const { encounters } = await getEncounters(client, SPEC_WCL);
    expect(encounters).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('getEncounters'), expect.stringContaining('Thin Raid'));
  });
});

describe('getRankingsLite', () => {
  it('throws on an unknown spec', async () => {
    await expect(getRankingsLite(fakeClient({}), 'NotASpec', 100, SPEC_WCL, 10, [], MYTHIC_DIFFICULTY)).rejects.toThrow('Unknown spec');
  });

  it('tries partitions newest-first and falls back when one is empty', async () => {
    const queried: (number | undefined)[] = [];
    const client = fakeClient({
      query: (_gql, vars) => {
        const partition = (vars as { partition?: number }).partition;
        queried.push(partition);
        const rankings = partition === 3 ? [] : [{ name: 'A', amount: 10, duration: 1000, report: { code: 'r1', fightID: 1 } }];
        return { worldData: { encounter: { name: 'Boss', characterRankings: { rankings } } } };
      },
    });
    const ranked = await getRankingsLite(client, 'SubtletyRogue', 100, SPEC_WCL, 10, [3, 2], MYTHIC_DIFFICULTY);
    expect(queried).toEqual([3, 2]);
    expect(ranked).toHaveLength(1);
    assert.exists(ranked[0]);
    expect(ranked[0].player).toBe('A');
  });

  it('passes the caller\'s difficulty through to the rankings query', async () => {
    const seen: (number | undefined)[] = [];
    const client = fakeClient({
      query: (_gql, vars) => {
        seen.push((vars as { difficulty?: number }).difficulty);
        return { worldData: { encounter: { name: 'Boss', characterRankings: { rankings: ranks(1) } } } };
      },
    });
    await getRankingsLite(client, 'SubtletyRogue', 100, SPEC_WCL, 10, [], NORMAL_DIFFICULTY);
    expect(seen).toEqual([NORMAL_DIFFICULTY]);
  });

  it('parses characterRankings when returned as a JSON string', async () => {
    const client = fakeClient({
      query: () => ({ worldData: { encounter: { name: 'Boss', characterRankings: JSON.stringify({ rankings: [{ name: 'A', report: { code: 'r', fightID: 1 } }] }) } } }),
    });
    const ranked = await getRankingsLite(client, 'SubtletyRogue', 100, SPEC_WCL, 10, [], MYTHIC_DIFFICULTY);
    assert.exists(ranked[0]);
    expect(ranked[0].player).toBe('A');
  });
});

describe('rankingsFromPartition', () => {
  const NEWEST = 3, PREVIOUS = 2;

  it('names the partition that answered, so every later read can be pinned to it', async () => {
    const tried: (number | null)[] = [];
    const result = await rankingsFromPartition([NEWEST, PREVIOUS], async partition => {
      tried.push(partition);
      return partition === NEWEST ? [] : ['a'];
    });
    expect(tried).toEqual([NEWEST, PREVIOUS]);
    expect(result).toEqual({ rows: ['a'], partition: PREVIOUS });
  });

  it('stops at the newest partition that has rows, leaving the older ones unqueried', async () => {
    const tried: (number | null)[] = [];
    const result = await rankingsFromPartition([NEWEST, PREVIOUS], async partition => {
      tried.push(partition);
      return ['a'];
    });
    expect(tried).toEqual([NEWEST]);
    expect(result.partition).toBe(NEWEST);
  });

  it('makes one unpartitioned attempt when the zone lists none, which is WCL\'s own default', async () => {
    const tried: (number | null)[] = [];
    const result = await rankingsFromPartition([], async partition => {
      tried.push(partition);
      return ['a'];
    });
    expect(tried).toEqual([null]);
    expect(result.partition).toBeNull();
  });

  it('reports no partition when every one of them is empty', async () => {
    expect(await rankingsFromPartition([NEWEST, PREVIOUS], async () => [])).toEqual({ rows: [], partition: null });
  });
});
