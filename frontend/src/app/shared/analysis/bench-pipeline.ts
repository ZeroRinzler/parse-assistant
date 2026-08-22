import { WclApiService } from '../../core/services/wcl-api';
import { ParseRanking, WclFight, WclReport } from '../../core/models/wcl.models';
import { logWarn } from '../../core/log';
import { Result, ok, missing } from '../../core/result';
import { toLoadError } from '../../core/transport/http-load-error';
import { ReportActor, findParseActor, toParseRankings, unwrapRankings } from './wcl-projections';

const TOP_PARSE_COUNT = 10;
// Over-fetch so a private/unfetchable top parse can be backfilled by the next-best one.
const CANDIDATE_POOL_COUNT = TOP_PARSE_COUNT * 2;
const MIN_SAMPLE_COUNT = 1;

export interface BenchParse {
  ranking: ParseRanking;
  report: WclReport;
  fight: WclFight;
  player: ReportActor;
}

interface BenchPayload<TParse> {
  encounterName: string;
  parses: TParse[];
}

export interface BenchSlice<TParse, TBench> {
  logSource: string;
  errorId: string;
  candidatePoolCount?: number;
  sampleTarget?: number;
  minSamples?: number;
  noRankingsMessage: string;
  tooFewParsesMessage?: (accepted: number) => string;
  /** Returning null drops the parse so the next candidate backfills it. */
  parse: (parse: BenchParse) => Promise<TParse | null>;
  bench: (payload: BenchPayload<TParse>) => Promise<TBench> | TBench;
}

export async function benchFromTopParses<TParse, TBench>(
  wclApi: WclApiService,
  query: { spec: string; encounterId: number; partition?: number | null },
  slice: BenchSlice<TParse, TBench>,
): Promise<Result<TBench>> {
  const { spec, encounterId, partition } = query;
  try {
    const limits = sliceLimits(slice);
    const rankings = toParseRankings(
      unwrapRankings(await wclApi.getRankings(spec, encounterId, partition ?? null)), limits.poolCount);
    if (!rankings.length) return missing(slice.noRankingsMessage);

    const payload = await collectParses(wclApi, slice, rankings, limits.sampleTarget);
    const accepted = payload.parses.length;
    if (accepted < limits.minSamples) return missing(slice.tooFewParsesMessage?.(accepted) ?? slice.noRankingsMessage);

    return ok(await slice.bench(payload));
  } catch (cause) {
    logWarn(`${slice.logSource}.getBench ${spec}:${encounterId}`, cause);
    return toLoadError(cause, slice.errorId);
  }
}

interface SliceLimits {
  poolCount: number;
  sampleTarget: number;
  minSamples: number;
}

function sliceLimits<TParse, TBench>(slice: BenchSlice<TParse, TBench>): SliceLimits {
  return {
    poolCount: slice.candidatePoolCount ?? CANDIDATE_POOL_COUNT,
    sampleTarget: slice.sampleTarget ?? TOP_PARSE_COUNT,
    minSamples: slice.minSamples ?? MIN_SAMPLE_COUNT,
  };
}

async function collectParses<TParse, TBench>(
  wclApi: WclApiService, slice: BenchSlice<TParse, TBench>, rankings: ParseRanking[], sampleTarget: number,
): Promise<BenchPayload<TParse>> {
  const parses: TParse[] = [];
  let encounterName = '';
  for (const ranking of rankings) {
    const accepted = await parseCandidate(wclApi, slice, ranking);
    if (!accepted) continue;
    parses.push(accepted.parse);
    encounterName ||= accepted.encounterName;
    if (parses.length >= sampleTarget) break;
  }
  return { encounterName, parses };
}

// An unfetchable or unbindable report drops the parse, never the bench.
async function parseCandidate<TParse, TBench>(
  wclApi: WclApiService, slice: BenchSlice<TParse, TBench>, ranking: ParseRanking,
): Promise<{ parse: TParse; encounterName: string } | null> {
  try {
    const report = await wclApi.getReport(ranking.report_code);
    const fight = report.fights.find(entry => entry.id === ranking.fight_id);
    const player = findParseActor(report.masterData?.actors, ranking);
    if (!fight || !player) return null;

    const parse = await slice.parse({ ranking, report, fight, player });
    return parse === null ? null : { parse, encounterName: fight.name };
  } catch (cause) {
    logWarn(`${slice.logSource} parse ${ranking.report_code}:${ranking.fight_id}`, cause);
    return null;
  }
}
