import { inject, Injectable } from '@angular/core';
import { WclApiService } from '../../core/wcl/wcl-api-service';
import type { DataFileApiService } from '../../core/data-files/data-file-api-service';
import { ParseRanking, TopParseSelection, WclFight, WclReport } from '../../core/wcl/wcl.models';
import { Rulebook } from '../rulebook/rulebook.models';
import { Result, Results } from '../../core/http/result';
import { HttpLoadErrors } from '../../core/http/http-load-error';
import { ReportActor } from './wcl-projections-service';
import { LoggerService } from '../../core/observability/logger-service';
import { WclProjectionsService } from './wcl-projections-service';
import { TopParseSelectionService } from './top-parse-selection-service';

@Injectable({ providedIn: 'root' })
export class BenchPipelineService {
  private readonly logger = inject(LoggerService);
  private readonly projections = inject(WclProjectionsService);
  private readonly topParses = inject(TopParseSelectionService);

  spellIdsByName(abilities: { name: string; spell_id: number }[]): Record<string, number> {
    const byName: Record<string, number> = {};
    for (const ability of abilities) if (ability.spell_id) byName[ability.name] = ability.spell_id;
    return byName;
  }

  async benchFromTopParses<TParse, TBench, TPlan = undefined>(
    wclApi: WclApiService,
    query: { spec: string; encounterId: number; selection?: TopParseSelection },
    slice: BenchSlice<TParse, TBench, TPlan>,
  ): Promise<Result<TBench>> {
    const { spec, encounterId } = query;
    const planned = await this.benchPlan(slice.rulebook, spec);
    if (!planned.ok) return planned;
    try {
      const limits = this.sliceLimits(slice);
      const selection = query.selection ?? await this.topParses.resolveTopParses(wclApi, spec, encounterId);
      const rankings = slice.candidatePoolCount ? selection.slice(0, slice.candidatePoolCount) : selection;
      if (!rankings.length) return Results.missing(slice.noRankingsMessage);

      const payload = await this.collectParses(wclApi, slice, planned.value, rankings, limits.sampleTarget);
      const accepted = payload.parses.length;
      if (accepted < limits.minSamples) return Results.missing(slice.tooFewParsesMessage?.(accepted) ?? slice.noRankingsMessage);

      return Results.ok(await this.benchEnvelope(wclApi, slice, planned.value, { spec, encounterId }, payload));
    } catch (cause) {
      this.logger.logWarn(`${slice.logSource}.getBench ${spec}:${encounterId}`, cause);
      return HttpLoadErrors.toLoadError(cause, slice.errorId);
    }
  }

  private async benchPlan<TPlan>(step: BenchRulebookStep<TPlan> | undefined, spec: string): Promise<Result<TPlan>> {
    if (!step) return Results.ok(undefined as TPlan);
    const rulebook = await step.dataFiles.getRulebook(spec);
    if (!rulebook.ok) return rulebook;
    const plan = step.plan(rulebook.value);
    return plan === null ? Results.missing(step.missingMessage) : Results.ok(plan);
  }

  private async benchEnvelope<TParse, TBench, TPlan>(
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
      ? { ability_icons: this.projections.abilityIcons(await wclApi.getAbilities(slice.iconSpellIds(body))) }
      : {};
    return { ...header, ...body, ...icons } as TBench;
  }

  private sliceLimits<TParse, TBench, TPlan>(slice: BenchSlice<TParse, TBench, TPlan>): SliceLimits {
    return {
      sampleTarget: slice.sampleTarget ?? TOP_PARSE_COUNT,
      minSamples: slice.minSamples ?? MIN_SAMPLE_COUNT,
    };
  }

  private async collectParses<TParse, TBench, TPlan>(
    wclApi: WclApiService, slice: BenchSlice<TParse, TBench, TPlan>, plan: TPlan,
    rankings: ParseRanking[], sampleTarget: number,
  ): Promise<BenchPayload<TParse>> {
    const parses: TParse[] = [];
    let encounterName = '';
    for (const ranking of rankings) {
      const accepted = await this.parseCandidate(wclApi, slice, plan, ranking);
      if (!accepted) continue;
      parses.push(accepted.parse);
      encounterName ||= accepted.encounterName;
      if (parses.length >= sampleTarget) break;
    }
    return { encounterName, parses };
  }

  // An unfetchable or unbindable report drops the parse, never the bench.
  private async parseCandidate<TParse, TBench, TPlan>(
    wclApi: WclApiService, slice: BenchSlice<TParse, TBench, TPlan>, plan: TPlan, ranking: ParseRanking,
  ): Promise<{ parse: TParse; encounterName: string } | null> {
    try {
      const report = await wclApi.getReport(ranking.report_code);
      const fight = report.fights.find(entry => entry.id === ranking.fight_id);
      const player = this.projections.findParseActor(report.masterData?.actors, ranking);
      if (!fight || !player) return null;

      const parse = await slice.parse({ ranking, report, fight, player }, plan);
      return parse === null ? null : { parse, encounterName: fight.name };
    } catch (cause) {
      this.logger.logWarn(`${slice.logSource} parse ${ranking.report_code}:${ranking.fight_id}`, cause);
      return null;
    }
  }
}

const TOP_PARSE_COUNT = 10;
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

interface BenchRulebookStep<TPlan> {
  dataFiles: DataFileApiService;
  /** Returning null stops the bench with `missingMessage`, for a spec whose rulebook names nothing this slice benches. */
  plan: (rulebook: Rulebook) => TPlan | null;
  missingMessage: string;
}

export interface BenchSlice<TParse, TBench, TPlan = undefined> {
  logSource: string;
  errorId: string;
  /** Trims the resolved pool for a slice that benches fewer candidates; it cannot deepen one. */
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

interface SliceLimits {
  sampleTarget: number;
  minSamples: number;
}
