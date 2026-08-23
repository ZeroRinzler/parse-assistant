import { WclApiService } from '../../core/services/wcl-api';
import type { DataFileApiService } from '../../core/services/data-file-api';
import { ParseRanking, WclFight, WclReport } from '../../core/models/wcl.models';
import { Rulebook } from '../../core/models/rulebook.models';
import { logWarn } from '../../core/log';
import { Result, ok, missing } from '../../core/result';
import { toLoadError } from '../../core/transport/http-load-error';
import { ReportActor, abilityIcons, findParseActor, toParseRankings, unwrapRankings } from './wcl-projections';

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

export interface BenchIdentity {
  spec: string;
  encounter_id: number;
  encounter_name: string;
}

export interface BenchHeader extends BenchIdentity {
  sample_count: number;
}

/** What a slice's bench callback returns: the pipeline spreads the header before it and bakes the icon map after it. */
type BenchBody<TBench> = Omit<TBench, keyof BenchHeader | 'ability_icons'>;

export function spellIdsByName(abilities: { name: string; spell_id: number }[]): Record<string, number> {
  const byName: Record<string, number> = {};
  for (const ability of abilities) if (ability.spell_id) byName[ability.name] = ability.spell_id;
  return byName;
}

interface BenchRulebookStep<TPlan> {
  dataFiles: DataFileApiService;
  /** Returning null stops the bench with `missingMessage`, for a spec whose rulebook names nothing this slice benches. */
  plan: (rulebook: Rulebook) => TPlan | null;
  missingMessage: string;
}

export interface BenchSlice<TParse, TBench, TPlan = undefined> {
  logSource: string;
  errorId: string;
  candidatePoolCount?: number;
  sampleTarget?: number;
  minSamples?: number;
  noRankingsMessage: string;
  tooFewParsesMessage?: (accepted: number) => string;
  /** 'identity' bakes no sample_count, for a file that exports one named parse rather than a sampled benchmark. */
  header?: 'sampled' | 'identity';
  rulebook?: BenchRulebookStep<TPlan>;
  /** Every spell id the baked file renders, so its icon map is complete and no card falls back. */
  iconSpellIds?: (bench: BenchBody<TBench>) => number[];
  /** Returning null drops the parse so the next candidate backfills it. */
  parse: (parse: BenchParse, plan: TPlan) => Promise<TParse | null>;
  bench: (payload: BenchPayload<TParse>, plan: TPlan) => Promise<BenchBody<TBench>> | BenchBody<TBench>;
}

export async function benchFromTopParses<TParse, TBench, TPlan = undefined>(
  wclApi: WclApiService,
  query: { spec: string; encounterId: number; partition?: number | null },
  slice: BenchSlice<TParse, TBench, TPlan>,
): Promise<Result<TBench>> {
  const { spec, encounterId, partition } = query;
  const planned = await benchPlan(slice.rulebook, spec);
  if (!planned.ok) return planned;
  try {
    const limits = sliceLimits(slice);
    const rankings = toParseRankings(
      unwrapRankings(await wclApi.getRankings(spec, encounterId, partition ?? null)), limits.poolCount);
    if (!rankings.length) return missing(slice.noRankingsMessage);

    const payload = await collectParses(wclApi, slice, planned.value, rankings, limits.sampleTarget);
    const accepted = payload.parses.length;
    if (accepted < limits.minSamples) return missing(slice.tooFewParsesMessage?.(accepted) ?? slice.noRankingsMessage);

    return ok(await benchEnvelope(wclApi, slice, planned.value, { spec, encounterId }, payload));
  } catch (cause) {
    logWarn(`${slice.logSource}.getBench ${spec}:${encounterId}`, cause);
    return toLoadError(cause, slice.errorId);
  }
}

async function benchPlan<TPlan>(step: BenchRulebookStep<TPlan> | undefined, spec: string): Promise<Result<TPlan>> {
  if (!step) return ok(undefined as TPlan);
  const rulebook = await step.dataFiles.getRulebook(spec);
  if (!rulebook.ok) return rulebook;
  const plan = step.plan(rulebook.value);
  return plan === null ? missing(step.missingMessage) : ok(plan);
}

async function benchEnvelope<TParse, TBench, TPlan>(
  wclApi: WclApiService,
  slice: BenchSlice<TParse, TBench, TPlan>,
  plan: TPlan,
  query: { spec: string; encounterId: number },
  payload: BenchPayload<TParse>,
): Promise<TBench> {
  const body = await slice.bench(payload, plan);
  const identity: BenchIdentity = {
    spec: query.spec, encounter_id: query.encounterId, encounter_name: payload.encounterName,
  };
  const header = slice.header === 'identity' ? identity : { ...identity, sample_count: payload.parses.length };
  const icons = slice.iconSpellIds
    ? { ability_icons: abilityIcons(await wclApi.getAbilities(slice.iconSpellIds(body))) }
    : {};
  return { ...header, ...body, ...icons } as TBench;
}

interface SliceLimits {
  poolCount: number;
  sampleTarget: number;
  minSamples: number;
}

function sliceLimits<TParse, TBench, TPlan>(slice: BenchSlice<TParse, TBench, TPlan>): SliceLimits {
  return {
    poolCount: slice.candidatePoolCount ?? CANDIDATE_POOL_COUNT,
    sampleTarget: slice.sampleTarget ?? TOP_PARSE_COUNT,
    minSamples: slice.minSamples ?? MIN_SAMPLE_COUNT,
  };
}

async function collectParses<TParse, TBench, TPlan>(
  wclApi: WclApiService, slice: BenchSlice<TParse, TBench, TPlan>, plan: TPlan,
  rankings: ParseRanking[], sampleTarget: number,
): Promise<BenchPayload<TParse>> {
  const parses: TParse[] = [];
  let encounterName = '';
  for (const ranking of rankings) {
    const accepted = await parseCandidate(wclApi, slice, plan, ranking);
    if (!accepted) continue;
    parses.push(accepted.parse);
    encounterName ||= accepted.encounterName;
    if (parses.length >= sampleTarget) break;
  }
  return { encounterName, parses };
}

// An unfetchable or unbindable report drops the parse, never the bench.
async function parseCandidate<TParse, TBench, TPlan>(
  wclApi: WclApiService, slice: BenchSlice<TParse, TBench, TPlan>, plan: TPlan, ranking: ParseRanking,
): Promise<{ parse: TParse; encounterName: string } | null> {
  try {
    const report = await wclApi.getReport(ranking.report_code);
    const fight = report.fights.find(entry => entry.id === ranking.fight_id);
    const player = findParseActor(report.masterData?.actors, ranking);
    if (!fight || !player) return null;

    const parse = await slice.parse({ ranking, report, fight, player }, plan);
    return parse === null ? null : { parse, encounterName: fight.name };
  } catch (cause) {
    logWarn(`${slice.logSource} parse ${ranking.report_code}:${ranking.fight_id}`, cause);
    return null;
  }
}
