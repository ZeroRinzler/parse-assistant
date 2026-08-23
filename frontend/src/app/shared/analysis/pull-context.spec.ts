import { assert, describe, it, expect } from 'vitest';
import { WclApiService } from '../../core/services/wcl-api';
import { WclTransportError } from '../../core/services/wcl-transport';
import { ok, transient } from '../../core/result';
import { WclReport } from '../../core/models/wcl.models';
import { wclReport } from '../../../testing/builders/wcl-fixtures';
import { PullContext, PullRef, analyzePull } from './pull-context';

const FIGHT_ID = 1;
const FIGHT_END_MS = 120_000;
const FIGHT_DURATION_S = 120;
const PULL: PullRef = { reportCode: 'rX', fightId: FIGHT_ID };
const ERROR_ID = 'slice.player-view';
const EMPTY_VIEW = 'empty';
const ANALYZED_VIEW = 'analyzed';
const REPORT = wclReport({ fightId: FIGHT_ID, endTimeMs: FIGHT_END_MS });

function wclFake(getReport: () => Promise<WclReport> = async () => REPORT): WclApiService {
  return { getReport } as unknown as WclApiService;
}

const SLICE = {
  logSource: 'Slice.loadPlayerView',
  errorId: ERROR_ID,
  emptyView: () => EMPTY_VIEW,
  analyze: async (_context: PullContext) => ANALYZED_VIEW,
};

function viewSlice(over: Partial<typeof SLICE> = {}): typeof SLICE {
  return { ...SLICE, ...over };
}

describe('analyzePull', () => {
  it('hands the analysis the report, the named fight, and the fight duration in seconds', async () => {
    const seen: PullContext[] = [];
    const result = await analyzePull(wclFake(), PULL, viewSlice({
      analyze: async context => { seen.push(context); return ANALYZED_VIEW; },
    }));
    expect(result).toEqual(ok(ANALYZED_VIEW));
    const [context] = seen;
    assert.exists(context);
    expect(context.report).toBe(REPORT);
    expect(context.fight.id).toBe(FIGHT_ID);
    expect(context.fightDurationS).toBe(FIGHT_DURATION_S);
  });

  it('returns the slice empty view when the fight is not in the report yet, without running the analysis', async () => {
    const UNLOGGED_FIGHT_ID = 99;
    let analyzed = false;
    const result = await analyzePull(wclFake(), { ...PULL, fightId: UNLOGGED_FIGHT_ID }, viewSlice({
      analyze: async () => { analyzed = true; return ANALYZED_VIEW; },
    }));
    expect(result).toEqual(ok(EMPTY_VIEW));
    expect(analyzed).toBe(false);
  });

  it('surfaces a WCL outage as transient, so the slice reports an outage rather than a repro id', async () => {
    const SERVER_UNREACHABLE_STATUS = 503;
    const wcl = wclFake(async () => { throw new WclTransportError('WCL down', SERVER_UNREACHABLE_STATUS); });
    expect(await analyzePull(wcl, PULL, viewSlice())).toEqual(transient('WCL is unreachable right now.'));
  });

  it('tags an unclassified report failure with the slice repro id instead of an empty view', async () => {
    const wcl = wclFake(async () => { throw new Error('WCL exploded'); });
    const result = await analyzePull(wcl, PULL, viewSlice());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatchObject({ kind: 'permanent', id: ERROR_ID });
  });

  it('routes a failure raised inside the analysis through the same tail', async () => {
    const result = await analyzePull(wclFake(), PULL, viewSlice({
      analyze: async () => { throw new Error('event fetch exploded'); },
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatchObject({ kind: 'permanent', id: ERROR_ID });
  });
});
