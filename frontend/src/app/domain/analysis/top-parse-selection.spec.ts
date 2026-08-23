import { describe, it, expect } from 'vitest';
import { WclApiService } from '../../core/wcl/wcl-api-service';
import { FixtureRanking, parseRankings } from '../../../testing/builders/wcl-fixtures';
import { TopParseSelectionService } from './top-parse-selection-service';
import { TestBed } from '@angular/core/testing';

const topParses = TestBed.inject(TopParseSelectionService);

const SPEC = 'SubtletyRogue';
const ENCOUNTER_ID = 3144;
const NEWEST_PARTITION = 3;
const PREVIOUS_PARTITION = 2;
/** The sampled top 10 plus 10 spare, the depth the module owns. */
const POOL_DEPTH = 20;

function wclFake(rankingsFor: (partition: number | null) => FixtureRanking[]): {
  api: WclApiService; asked: (number | null)[];
} {
  const asked: (number | null)[] = [];
  const api = {
    getRankings: async (_spec: string, _encounterId: number, partition: number | null) => {
      asked.push(partition);
      return { rankings: rankingsFor(partition) };
    },
  } as unknown as WclApiService;
  return { api, asked };
}

describe('resolveTopParses', () => {
  it('falls back to the older partition, with its rows mapped to what a parse refetch needs', async () => {
    const { api, asked } = wclFake(partition => (partition === NEWEST_PARTITION ? [] : parseRankings(1)));

    const selection = await topParses.resolveTopParses(api, SPEC, ENCOUNTER_ID, [NEWEST_PARTITION, PREVIOUS_PARTITION]);

    expect(asked).toEqual([NEWEST_PARTITION, PREVIOUS_PARTITION]);
    expect(selection).toEqual([{ player: 'P1', server: '', report_code: 'r1', fight_id: 1 }]);
  });

  it('stops at the newest partition that has parses, leaving the older ones unqueried', async () => {
    const { api, asked } = wclFake(() => parseRankings(1));

    const selection = await topParses.resolveTopParses(api, SPEC, ENCOUNTER_ID, [NEWEST_PARTITION, PREVIOUS_PARTITION]);

    expect(asked).toEqual([NEWEST_PARTITION]);
    expect(selection).toHaveLength(1);
  });

  it('makes one unpartitioned attempt when no partition is named, which is WCL\'s own default', async () => {
    const { api, asked } = wclFake(() => parseRankings(1));

    const selection = await topParses.resolveTopParses(api, SPEC, ENCOUNTER_ID);

    expect(asked).toEqual([null]);
    expect(selection).toHaveLength(1);
  });

  it('resolves an empty pool when every partition is empty', async () => {
    const { api } = wclFake(() => []);

    expect(await topParses.resolveTopParses(api, SPEC, ENCOUNTER_ID, [NEWEST_PARTITION, PREVIOUS_PARTITION])).toEqual([]);
  });

  it('keeps a ranking list that exactly fills the pool depth', async () => {
    const { api } = wclFake(() => parseRankings(POOL_DEPTH));

    const selection = await topParses.resolveTopParses(api, SPEC, ENCOUNTER_ID);

    expect(selection).toHaveLength(POOL_DEPTH);
  });

  it('cuts one ranked parse past the pool depth, so the pool never outgrows the depth it reports', async () => {
    const ONE_OVER_DEPTH = POOL_DEPTH + 1;
    const { api } = wclFake(() => parseRankings(ONE_OVER_DEPTH));

    const selection = await topParses.resolveTopParses(api, SPEC, ENCOUNTER_ID);

    expect(selection).toHaveLength(POOL_DEPTH);
    expect(selection.map(row => row.report_code).at(-1)).toBe(`r${POOL_DEPTH}`);
  });
});
