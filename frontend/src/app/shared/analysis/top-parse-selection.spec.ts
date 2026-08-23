import { describe, it, expect } from 'vitest';
import { WclApiService } from '../../core/services/wcl-api';
import { FixtureRanking, parseRankings } from '../../../testing/builders/wcl-fixtures';
import { resolveTopParses } from './top-parse-selection';

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
  it('names the partition that answered, with its rows mapped to what a parse refetch needs', async () => {
    const { api, asked } = wclFake(partition => (partition === NEWEST_PARTITION ? [] : parseRankings(1)));

    const selection = await resolveTopParses(api, SPEC, ENCOUNTER_ID, [NEWEST_PARTITION, PREVIOUS_PARTITION]);

    expect(asked).toEqual([NEWEST_PARTITION, PREVIOUS_PARTITION]);
    expect(selection).toEqual({
      partition: PREVIOUS_PARTITION,
      rows: [{ player: 'P1', server: '', report_code: 'r1', fight_id: 1 }],
      depth: POOL_DEPTH,
    });
  });

  it('stops at the newest partition that has parses, leaving the older ones unqueried', async () => {
    const { api, asked } = wclFake(() => parseRankings(1));

    const selection = await resolveTopParses(api, SPEC, ENCOUNTER_ID, [NEWEST_PARTITION, PREVIOUS_PARTITION]);

    expect(asked).toEqual([NEWEST_PARTITION]);
    expect(selection.partition).toBe(NEWEST_PARTITION);
  });

  it('makes one unpartitioned attempt when no partition is named, which is WCL\'s own default', async () => {
    const { api, asked } = wclFake(() => parseRankings(1));

    const selection = await resolveTopParses(api, SPEC, ENCOUNTER_ID);

    expect(asked).toEqual([null]);
    expect(selection.partition).toBeNull();
  });

  it('resolves an empty pool when every partition is empty', async () => {
    const { api } = wclFake(() => []);

    expect(await resolveTopParses(api, SPEC, ENCOUNTER_ID, [NEWEST_PARTITION, PREVIOUS_PARTITION]))
      .toEqual({ partition: null, rows: [], depth: POOL_DEPTH });
  });

  it('keeps a ranking list that exactly fills the pool depth', async () => {
    const { api } = wclFake(() => parseRankings(POOL_DEPTH));

    const selection = await resolveTopParses(api, SPEC, ENCOUNTER_ID);

    expect(selection.rows).toHaveLength(POOL_DEPTH);
    expect(selection.depth).toBe(POOL_DEPTH);
  });

  it('cuts one ranked parse past the pool depth, so the pool never outgrows the depth it reports', async () => {
    const ONE_OVER_DEPTH = POOL_DEPTH + 1;
    const { api } = wclFake(() => parseRankings(ONE_OVER_DEPTH));

    const selection = await resolveTopParses(api, SPEC, ENCOUNTER_ID);

    expect(selection.rows).toHaveLength(POOL_DEPTH);
    expect(selection.rows.map(row => row.report_code).at(-1)).toBe(`r${POOL_DEPTH}`);
  });
});
