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

const NOW_S = 1_760_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

// WCL dates a ranking in milliseconds, so a fixture pull `ageDays` old is stamped in them too.
const ranks = (count: number, ageDays = 1): WclRawRanking[] =>
  Array.from({ length: count }, (_unused, index) => ({
    name: `P${index}`, report: { code: `r${index}`, fightID: index }, startTime: NOW_S * 1000 - ageDays * DAY_MS,
  }));

describe('getEncounters', () => {
  // The retire test asserts on the warning; the log spy only keeps the runner output clean.
  let warnSpy: MockInstance<typeof console.warn>;
  let logSpy: MockInstance<typeof console.log>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => { warnSpy.mockRestore(); logSpy.mockRestore(); });

  const ABYSS = 53, SPOREFALL = 50, DUMMY = 52, FINISHED = 46;

  const finishedZone = { id: FINISHED, name: 'VS / DR / MQD', frozen: false, encounters: [{ id: 3176, name: 'Imperator' }, { id: 3177, name: 'Vorasius' }] };

  // Modeled on the real Midnight worldData, which really does run two raids at once alongside a still-ranked finished tier.
  const expansions = [{
    id: 7, name: 'Midnight', zones: [
      finishedZone,
      { id: SPOREFALL, name: 'Sporefall', frozen: false, encounters: [{ id: 3159, name: 'Rotmire' }] },
      { id: DUMMY, name: 'Dummy Dome', frozen: false, encounters: [{ id: 3591, name: 'Sinister Single' }] },
      { id: ABYSS, name: 'The Venomous Abyss', frozen: false, encounters: [{ id: 3470, name: "Nek'zali" }, { id: 3445, name: 'Sentinels' }] },
      { id: 54, name: 'The Venomous Abyss', frozen: true, encounters: [{ id: 3480, name: 'Frozen copy' }] },
      { id: 47, name: 'Mythic+ Season 1', frozen: false, encounters: [{ id: 112526, name: 'Dungeon' }] },
      { id: 510, name: 'The Venomous Abyss Complete Raid', frozen: false, encounters: [{ id: 3191, name: 'Aggregate' }] },
    ],
  }];

  const STALE_DAYS = 30;
  const rankingsByEncounter: Record<number, WclRawRanking[]> = {
    3470: ranks(10), 3445: ranks(10), 3159: ranks(10), 3191: ranks(10), 112526: ranks(10),
    3176: ranks(10, STALE_DAYS), 3177: ranks(10, STALE_DAYS), 3591: [],
  };

  function contentClient(overrides: Partial<FakeHandlers> = {}, probed?: number[]): WclQueryClient {
    return fakeClient({
      query: (gql, vars) => {
        if (gql.includes('expansions')) return { worldData: { expansions } };
        const encounterID = (vars as { encounterID: number }).encounterID;
        probed?.push(encounterID);
        return { worldData: { encounter: { name: 'Boss', characterRankings: { rankings: rankingsByEncounter[encounterID] ?? [] } } } };
      },
      ...overrides,
    });
  }

  describe('with no raid on record', () => {
    it('adopts every raid being progressed right now, newest first, and leaves the finished tier behind', async () => {
      const { encounters, protectedIds, zones, reset } = await getEncounters(contentClient(), SPEC_WCL, [], NOW_S);
      expect(zones).toEqual([
        { zone_id: ABYSS, zone_name: 'The Venomous Abyss' },
        { zone_id: SPOREFALL, zone_name: 'Sporefall' },
      ]);
      expect(encounters.map(encounter => encounter.id)).toEqual([3470, 3445, 3159]);
      expect([...protectedIds].sort((a, b) => a - b)).toEqual([3159, 3445, 3470]);
      expect(reset).toBe(true);
    });

    it('never adopts a finished tier, however many real parses it still ranks (boundary: same count, only older)', async () => {
      const onlyFinished = [{ id: 7, name: 'Midnight', zones: [finishedZone] }];
      const client = contentClient({ query: (gql, vars) => {
        if (gql.includes('expansions')) return { worldData: { expansions: onlyFinished } };
        const encounterID = (vars as { encounterID: number }).encounterID;
        return { worldData: { encounter: { name: 'Boss', characterRankings: { rankings: rankingsByEncounter[encounterID] ?? [] } } } };
      } });
      const { encounters, zones, reset } = await getEncounters(client, SPEC_WCL, [], NOW_S);
      expect(encounters).toHaveLength(0);
      expect(zones).toEqual([]);
      expect(reset).toBe(false);
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
      const { encounters } = await getEncounters(client, SPEC_WCL, [], NOW_S);
      expect(encounters.map(encounter => encounter.id)).toEqual([9100]);
      expect(difficultiesTried).toEqual([MYTHIC_DIFFICULTY, HEROIC_DIFFICULTY]);
    });

    it('adopts nothing when a zone\'s only parses are privacy-anonymized (the "Dummy Dome" case)', async () => {
      const anonymized: WclRawRanking[] = Array.from({ length: 8 }, (_unused, index) => ({
        name: `Character 13600${index}-1163300${index}`, report: { code: `r${index}`, fightID: index }, startTime: NOW_S * 1000,
      }));
      const client = fakeClient({
        query: (gql) => {
          if (gql.includes('expansions')) {
            return { worldData: { expansions: [{ id: 7, name: 'Midnight', zones: [{ id: DUMMY, name: 'Dummy Dome', frozen: false, encounters: [{ id: 3591, name: 'Sinister Single' }] }] }] } };
          }
          return { worldData: { encounter: { name: 'Sinister Single', characterRankings: { rankings: anonymized } } } };
        },
      });
      expect((await getEncounters(client, SPEC_WCL, [], NOW_S)).encounters).toHaveLength(0);
    });

    it('adopts nothing from a zone that stays below the liveness threshold', async () => {
      const client = fakeClient({
        query: (gql, vars) => {
          if (gql.includes('expansions')) {
            return { worldData: { expansions: [{ id: 7, name: 'Midnight', zones: [{ id: 60, name: 'Thin Raid', frozen: false, encounters: [{ id: 9001, name: 'Boss' }] }] }] } };
          }
          // Only the first probe spec returns parses, and just 2 at Mythic alone - below the threshold of 3.
          const className = (vars as { className: string }).className;
          const difficulty = (vars as { difficulty: number }).difficulty;
          const rankings = className === 'Mage' && difficulty === MYTHIC_DIFFICULTY ? ranks(2) : [];
          return { worldData: { encounter: { name: 'Boss', characterRankings: { rankings } } } };
        },
      });
      expect((await getEncounters(client, SPEC_WCL, [], NOW_S)).encounters).toHaveLength(0);
    });
  });

  describe('with raids already on record', () => {
    it('keeps them without probing them, so a run that cannot confirm one changes nothing', async () => {
      const probed: number[] = [];
      const { encounters, zones, reset } = await getEncounters(
        contentClient({}, probed), SPEC_WCL, [ABYSS, SPOREFALL], NOW_S);
      expect(zones.map(raid => raid.zone_id)).toEqual([ABYSS, SPOREFALL]);
      expect(encounters.map(encounter => encounter.id)).toEqual([3470, 3445, 3159]);
      expect(reset).toBe(false);
      expect([...new Set(probed)].sort((a, b) => a - b)).toEqual([3176, 3591]);
    });

    it('lets a second raid join an existing one instead of replacing it, protecting both', async () => {
      const { zones, protectedIds, reset } = await getEncounters(contentClient(), SPEC_WCL, [SPOREFALL], NOW_S);
      expect(zones.map(raid => raid.zone_id)).toEqual([ABYSS, SPOREFALL]);
      expect([...protectedIds].sort((a, b) => a - b)).toEqual([3159, 3445, 3470]);
      expect(reset).toBe(true);
    });

    it('retires a recorded raid WCL has frozen or dropped, and stops protecting its encounters', async () => {
      const RETIRED = 44;
      const { zones, protectedIds, reset } = await getEncounters(
        contentClient(), SPEC_WCL, [ABYSS, SPOREFALL, RETIRED], NOW_S);
      expect(zones.map(raid => raid.zone_id)).toEqual([ABYSS, SPOREFALL]);
      expect([...protectedIds].sort((a, b) => a - b)).toEqual([3159, 3445, 3470]);
      expect(reset).toBe(true);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('getEncounters'), expect.stringContaining(String(RETIRED)));
    });

    it('propagates a BudgetExceededError raised while probing', async () => {
      const client = contentClient({ assertBudget: () => { throw new BudgetExceededError('low'); } });
      await expect(getEncounters(client, SPEC_WCL, [], NOW_S)).rejects.toThrow(BudgetExceededError);
    });
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
