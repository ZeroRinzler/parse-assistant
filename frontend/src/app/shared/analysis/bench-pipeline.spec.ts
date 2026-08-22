import { describe, it, expect } from 'vitest';
import { WclApiService } from '../../core/services/wcl-api';
import { WclTransportError } from '../../core/services/wcl-transport';
import { ok, missing, transient } from '../../core/result';
import { FixtureRanking, parseRankings, wclReport, reportsByCode } from '../../../testing/builders/wcl-fixtures';
import { BenchSlice, benchFromTopParses } from './bench-pipeline';

const SPEC = 'SubtletyRogue';
const ENCOUNTER_ID = 3144;
const QUERY = { spec: SPEC, encounterId: ENCOUNTER_ID };
const BOSS_NAME = 'Boss';
const NO_RANKINGS_MESSAGE = 'No top parses for this encounter.';
const TOO_FEW_MESSAGE = 'No fetchable top parses for this encounter.';
const BENCH_ERROR_ID = 'slice.bench';
const CANDIDATE_POOL_COUNT = 20;
const SAMPLE_TARGET = 10;

function wclFake(
  over: { rankings?: FixtureRanking[]; getRankings?: () => Promise<unknown>; getReport?: (code: string) => Promise<unknown> } = {},
): WclApiService {
  return {
    getRankings: over.getRankings ?? (async () => ({ rankings: over.rankings ?? parseRankings(CANDIDATE_POOL_COUNT) })),
    getReport: over.getReport ?? reportsByCode(),
  } as unknown as WclApiService;
}

interface CodeBench { encounterName: string; codes: string[] }

function codeSlice(over: Partial<BenchSlice<string, CodeBench>> = {}): BenchSlice<string, CodeBench> {
  return {
    logSource: 'CodeSlice',
    errorId: BENCH_ERROR_ID,
    candidatePoolCount: CANDIDATE_POOL_COUNT,
    sampleTarget: SAMPLE_TARGET,
    minSamples: 1,
    noRankingsMessage: NO_RANKINGS_MESSAGE,
    tooFewParsesMessage: accepted => `${TOO_FEW_MESSAGE} (${accepted})`,
    parse: ({ ranking }) => Promise.resolve(ranking.report_code),
    bench: ({ encounterName, parses }) => ({ encounterName, codes: parses }),
    ...over,
  };
}

describe('benchFromTopParses', () => {
  it('hands the slice every accepted parse in acceptance order, named by the first fight', async () => {
    const CANDIDATES = 2;
    const result = await benchFromTopParses(wclFake({ rankings: parseRankings(CANDIDATES) }), QUERY, codeSlice());
    expect(result).toEqual(ok({ encounterName: BOSS_NAME, codes: ['r1', 'r2'] }));
  });

  it('stops fetching once the slice\'s sample target is met', async () => {
    const TARGET = 2;
    const fetched: string[] = [];
    const reports = reportsByCode();
    const wcl = wclFake({
      getReport: async (code: string) => { fetched.push(code); return reports(code); },
    });
    const result = await benchFromTopParses(wcl, QUERY, codeSlice({ sampleTarget: TARGET }));
    expect(result).toEqual(ok({ encounterName: BOSS_NAME, codes: ['r1', 'r2'] }));
    expect(fetched).toEqual(['r1', 'r2']);
  });

  it('backfills past a report WCL will not serve', async () => {
    const TARGET = 2;
    const PRIVATE_CODE = 'r1';
    const wcl = wclFake({ getReport: reportsByCode({ privateCode: PRIVATE_CODE }) });
    const result = await benchFromTopParses(wcl, QUERY, codeSlice({ sampleTarget: TARGET }));
    expect(result).toEqual(ok({ encounterName: BOSS_NAME, codes: ['r2', 'r3'] }));
  });

  it('backfills past a candidate the slice itself rejects', async () => {
    const TARGET = 2;
    const REJECTED_CODE = 'r2';
    const slice = codeSlice({
      sampleTarget: TARGET,
      parse: ({ ranking }) => Promise.resolve(ranking.report_code === REJECTED_CODE ? null : ranking.report_code),
    });
    const result = await benchFromTopParses(wclFake(), QUERY, slice);
    expect(result).toEqual(ok({ encounterName: BOSS_NAME, codes: ['r1', 'r3'] }));
  });

  it('backfills past a report the ranked player is absent from', async () => {
    const TARGET = 1;
    const ANONYMOUS_CODE = 'r1';
    const reports = reportsByCode();
    const wcl = wclFake({
      getReport: async (code: string) => (code === ANONYMOUS_CODE ? wclReport({ actors: [] }) : reports(code)),
    });
    const result = await benchFromTopParses(wcl, QUERY, codeSlice({ sampleTarget: TARGET }));
    expect(result).toEqual(ok({ encounterName: BOSS_NAME, codes: ['r2'] }));
  });

  it('backfills past a report that never ran the ranked fight', async () => {
    const TARGET = 1;
    const OTHER_FIGHT_CODE = 'r1';
    const UNRANKED_FIGHT_ID = 99;
    const reports = reportsByCode();
    const wcl = wclFake({
      getReport: async (code: string) => (code === OTHER_FIGHT_CODE ? wclReport({ fightId: UNRANKED_FIGHT_ID }) : reports(code)),
    });
    const result = await benchFromTopParses(wcl, QUERY, codeSlice({ sampleTarget: TARGET }));
    expect(result).toEqual(ok({ encounterName: BOSS_NAME, codes: ['r2'] }));
  });

  it('reports an empty ranking pool as missing, without touching a report', async () => {
    const result = await benchFromTopParses(wclFake({ rankings: [] }), QUERY, codeSlice());
    expect(result).toEqual(missing(NO_RANKINGS_MESSAGE));
  });

  it('benches a pool that exactly meets the slice\'s floor', async () => {
    const FLOOR = 2;
    const result = await benchFromTopParses(
      wclFake({ rankings: parseRankings(FLOOR) }), QUERY, codeSlice({ minSamples: FLOOR }));
    expect(result).toEqual(ok({ encounterName: BOSS_NAME, codes: ['r1', 'r2'] }));
  });

  it('reports a pool one parse short of the floor as missing, counting the usable parses', async () => {
    const FLOOR = 2;
    const USABLE = FLOOR - 1;
    const result = await benchFromTopParses(
      wclFake({ rankings: parseRankings(USABLE) }), QUERY, codeSlice({ minSamples: FLOOR }));
    expect(result).toEqual(missing(`${TOO_FEW_MESSAGE} (${USABLE})`));
  });

  it('surfaces a WCL outage as transient, so the slice reports an outage rather than a repro id', async () => {
    const SERVER_UNREACHABLE_STATUS = 503;
    const outage = new WclTransportError(`WCL API error (${SERVER_UNREACHABLE_STATUS})`, SERVER_UNREACHABLE_STATUS);
    const wcl = wclFake({ getRankings: async () => { throw outage; } });
    const result = await benchFromTopParses(wcl, QUERY, codeSlice());
    expect(result).toEqual(transient('WCL is unreachable right now.'));
  });

  it('tags a WCL failure with the slice\'s repro id instead of a silent empty bench', async () => {
    const wcl = wclFake({ getRankings: async () => { throw new Error('WCL exploded'); } });
    const result = await benchFromTopParses(wcl, QUERY, codeSlice());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatchObject({ kind: 'permanent', id: BENCH_ERROR_ID });
  });

  it('samples the partition it was handed', async () => {
    const RESOLVED_PARTITION = 2;
    const asked: (number | null)[] = [];
    const wcl = {
      getRankings: async (_spec: string, _encounterId: number, partition: number | null) => {
        asked.push(partition);
        return { rankings: [] };
      },
    } as unknown as WclApiService;
    await benchFromTopParses(wcl, { ...QUERY, partition: RESOLVED_PARTITION }, codeSlice());
    await benchFromTopParses(wcl, QUERY, codeSlice());
    expect(asked).toEqual([RESOLVED_PARTITION, null]);
  });
});
