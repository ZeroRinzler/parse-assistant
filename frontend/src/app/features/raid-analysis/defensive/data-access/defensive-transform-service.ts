import { Injectable, inject } from '@angular/core';
import { WclApiService } from '../../../../core/wcl/wcl-api-service';
import { DataFileApiService } from '../../../../core/data-files/data-file-api-service';
import { TopParseSelection } from '../../../../core/wcl/wcl.models';
import { RulebookDefensive } from '../../../../domain/rulebook/rulebook.models';
import { BurstWindow } from '../../../../domain/analysis/analysis.models';
import { PerDefensiveBenchmark } from '../../../../domain/encounter/encounter.models';
import { Result } from '../../../../core/http/result';
import { mean, deviation, extent, group, mode } from 'd3-array';
import { round, groupByTime, getOrInsert, avgOr, medianOr } from '../../../../domain/analysis/analysis-math';
import { HoldWindow } from '../../../../domain/analysis/hold-targets-service';
import { AuraWindowsService } from '../../../../domain/analysis/aura-windows-service';
import { WclProjectionsService, TimedEvent } from '../../../../domain/analysis/wcl-projections-service';
import { BenchPipelineService, BenchParse } from '../../../../domain/analysis/bench-pipeline-service';
import { DataSource } from '../../../../core/data-source/data-source';
import { DefensiveBench, DefensivePlanMeta } from './defensive-data-source';
import { HoldTargetsService } from '../../../../domain/analysis/hold-targets-service';
import { CastCadenceService } from '../../../../domain/analysis/cast-cadence-service';

const CONSENSUS_FRAC = 0.5;
const MEMBER_MAJORITY_FRAC = 0.5;
const CLUSTER_MERGE_S = 20;
const ABILITY_BREAKDOWN_TOP_N = 6;
const NO_DEFENSIVE_BENCH_MESSAGE = 'Not yet ingested.';

export interface ParseDefensiveSummary {
  name: string;
  cast_times_s: number[];
  first_cast_s: number | null;
  fight_duration_s: number;
  hold_windows: HoldWindow[];
  cast_pattern: 'hold' | 'on_cooldown';
}

export interface ParseDefWindow {
  time_s: number;
  window_length_s: number;
  window_damage: number;
  /** Index of the parse this window came from, so clustering counts DISTINCT parses. */
  parse_index: number;
  defensive_name: string;
  spell_id: number;
  ref_game_id: number | null;
  ability_breakdown: { spell_id: number; damage: number }[];
}

/** One window hit: `[atS, damage, abilityId, sourceId]` (sorted by time). */
type WindowHit = [number, number, number, number | null];

@Injectable({ providedIn: 'root' })
export class DefensiveTransformService implements DataSource<DefensiveBench> {
  private readonly holdTargets = inject(HoldTargetsService);
  private readonly castCadence = inject(CastCadenceService);
  private readonly auraWindows = inject(AuraWindowsService);
  private readonly benchPipeline = inject(BenchPipelineService);
  private readonly wclProjections = inject(WclProjectionsService);
  private readonly wclApi = inject(WclApiService);
  private readonly dataFiles = inject(DataFileApiService);

  async getBench(spec: string, encounterId: number, selection?: TopParseSelection): Promise<Result<DefensiveBench>> {
    return this.benchPipeline.benchFromTopParses(this.wclApi, { spec, encounterId, selection }, {
      logSource: 'DefensiveTransformService',
      errorId: 'defensive.bench',
      noRankingsMessage: NO_DEFENSIVE_BENCH_MESSAGE,
      rulebook: {
        dataFiles: this.dataFiles,
        plan: (rulebook): RulebookDefensive[] | null => rulebook.defensives.length ? rulebook.defensives : null,
        missingMessage: NO_DEFENSIVE_BENCH_MESSAGE,
      },
      iconSpellIds: bench => [
        ...Object.values(bench.cd_spell_ids),
        ...bench.defensive_windows.flatMap(window => window.ability_breakdown.map(ability => ability.spell_id)),
      ],
      parse: (parse, defensives) => this.parseDefensives(parse, defensives),
      bench: ({ parses }, defensives) => {
        const allWindows = parses.flatMap(
          (parse, parseIndex) => parse.windows.map(window => ({ ...window, parse_index: parseIndex })));
        return {
          per_defensive_benchmarks: this.aggregateDefensiveBenchmarks(parses.map(parse => parse.summaries), defensives),
          defensive_windows: this.clusterDefensiveWindows(allWindows, parses.length),
          defensives: this.defensivePlanMeta(defensives),
          cd_spell_ids: this.benchPipeline.spellIdsByName(defensives),
        };
      },
    });
  }

  private async parseDefensives(
    { ranking, report, fight, player }: BenchParse, defensives: RulebookDefensive[],
  ): Promise<{ windows: ParseDefWindow[]; summaries: ParseDefensiveSummary[] }> {
    const gameIdByActorId = new Map<number, number>();
    for (const enemy of report.masterData?.enemies ?? []) gameIdByActorId.set(enemy.id, enemy.gameID);

    const [buffs, casts, dmgTaken] = await Promise.all([
      this.wclApi.getAllEvents(ranking.report_code, fight.id, 'Buffs', fight.startTime, fight.endTime, player.id),
      this.wclApi.getAllEvents(ranking.report_code, fight.id, 'Casts', fight.startTime, fight.endTime, player.id),
      this.wclApi.getAllEvents(ranking.report_code, fight.id, 'DamageTaken', fight.startTime, fight.endTime, player.id),
    ]);

    const fightDurationS = this.wclProjections.relativeS(fight.endTime, fight.startTime);
    const buffWindows = this.auraWindows.buildAuraWindows(this.wclProjections.withRelativeS(buffs, fight.startTime));
    return {
      windows: this.findParseDefensiveWindows(this.wclProjections.withRelativeS(dmgTaken, fight.startTime), fightDurationS, buffWindows, defensives, gameIdByActorId),
      summaries: this.summarizeDefensiveCasts(defensives, buffWindows, this.wclProjections.withRelativeS(casts, fight.startTime), fightDurationS),
    };
  }

  protected defensivePlanMeta(defensives: RulebookDefensive[]): DefensivePlanMeta[] {
    return defensives.map(defensive => ({
      name: defensive.name,
      spell_id: defensive.spell_id,
      cooldown: defensive.cooldown,
      usage_rule: defensive.usage_rule ?? null,
      talent_gated: !!defensive.talent_gated,
    }));
  }

  private castTimesOf(spellId: number, castEvents: TimedEvent[]): number[] {
    const times: number[] = [];
    for (const cast of castEvents) {
      if (cast.type === 'cast' && cast.abilityGameID === spellId) times.push(round(cast.atS));
    }
    return times;
  }

  // Each buff span (or explicit cast for self-buff-less defensives) is one use; hold windows mark casts delayed > 8s past reset.
  protected summarizeDefensiveCasts(
    defensives: RulebookDefensive[],
    buffWindows: Map<number, [number, number | null][]>,
    castEvents: TimedEvent[],
    fightDurationS: number,
  ): ParseDefensiveSummary[] {
    const summaries: ParseDefensiveSummary[] = [];
    for (const defensive of defensives) {
      const spellId = defensive.spell_id;
      const cooldownS = defensive.cooldown;
      const buffTimes = (buffWindows.get(spellId) ?? []).map(buffWindow => round(buffWindow[0]));
      const castTimes = buffTimes.length ? buffTimes : this.castTimesOf(spellId, castEvents);

      castTimes.sort((a, b) => a - b);
      const holdWindows = this.holdTargets.detectHoldWindows(castTimes, cooldownS);

      const firstCastS = castTimes[0];
      if (firstCastS != null) {
        summaries.push({
          name: defensive.name,
          cast_times_s: castTimes,
          first_cast_s: firstCastS,
          fight_duration_s: fightDurationS,
          hold_windows: holdWindows,
          cast_pattern: holdWindows.length ? 'hold' : 'on_cooldown',
        });
      }
    }
    return summaries;
  }

  protected windowDamageBreakdown(windowHits: WindowHit[]): { spell_id: number; damage: number }[] {
    const abilityDmg = new Map<number, number>();
    // Normalize before grouping so raw ids that fold to one spell (melee, synthetic negatives) sum, not split into rows.
    for (const [, damage, abilityId] of windowHits) {
      if (abilityId) {
        const spellId = this.wclProjections.normalizeAbilityId(abilityId);
        abilityDmg.set(spellId, (abilityDmg.get(spellId) ?? 0) + damage);
      }
    }
    return [...abilityDmg.entries()]
      .sort((a, b) => b[1] - a[1]).slice(0, ABILITY_BREAKDOWN_TOP_N)
      .map(([spell_id, damage]) => ({ spell_id, damage }));
  }

  private topSourceGameId(windowHits: WindowHit[], gameIdByActorId: Map<number, number>): number | null {
    const dmgBySource = new Map<number, number>();
    for (const [, damage, , sourceId] of windowHits) {
      if (sourceId != null && gameIdByActorId.has(sourceId)) dmgBySource.set(sourceId, (dmgBySource.get(sourceId) ?? 0) + damage);
    }
    const topSource = [...dmgBySource.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    return topSource != null ? (gameIdByActorId.get(topSource) ?? null) : null;
  }

  // Open buffs run to fight end, never a rulebook duration.
  protected findParseDefensiveWindows(
    damageTaken: TimedEvent[], fightDurationS: number,
    buffWindows: Map<number, [number, number | null][]>,
    defensives: RulebookDefensive[],
    gameIdByActorId: Map<number, number>,
  ): ParseDefWindow[] {
    const hits = damageTaken
      .filter(event => event.type === 'damage' && (event.amount ?? 0) + (event.absorbed ?? 0) > 0)
      .map(event => [event.atS, (event.amount ?? 0) + (event.absorbed ?? 0), event.abilityGameID, event.sourceID ?? null] as WindowHit)
      .sort((a, b) => a[0] - b[0]);
    if (!hits.length) return [];

    const result: ParseDefWindow[] = [];
    for (const defensive of defensives) {
      const spellId = defensive.spell_id;

      for (const buffWindow of (buffWindows.get(spellId) ?? [])) {
        const startS = buffWindow[0];
        const endS = buffWindow[1] ?? fightDurationS;
        const windowHits = hits.filter(hit => hit[0] >= startS && hit[0] <= endS);
        const windowDmg = windowHits.reduce((sum, hit) => sum + hit[1], 0);

        result.push({
          time_s: round(startS),
          window_length_s: round(endS - startS),
          window_damage: windowDmg,
          parse_index: 0,
          defensive_name: defensive.name,
          spell_id: spellId,
          ref_game_id: this.topSourceGameId(windowHits, gameIdByActorId),
          ability_breakdown: this.windowDamageBreakdown(windowHits),
        });
      }
    }
    return result.sort((a, b) => a.time_s - b.time_s);
  }

  protected clusterDamageStats(damages: number[]): { dmg_avg: number; dmg_stddev: number; dmg_min: number; dmg_max: number } {
    const [min = 0, max = 0] = extent(damages);
    return {
      dmg_avg: Math.round((mean(damages) ?? 0)),
      dmg_stddev: Math.round((deviation(damages) ?? 0)),
      dmg_min: Math.round(min),
      dmg_max: Math.round(max),
    };
  }

  protected clusterAbilityBreakdown(cluster: ParseDefWindow[]): BurstWindow['ability_breakdown'] {
    // Sum per parse first so a parse landing an ability across several of its windows counts once toward the gate.
    const damageByAbilityParse = new Map<number, Map<number, number>>();
    for (const member of cluster) {
      for (const ability of member.ability_breakdown) {
        const byParse = getOrInsert(damageByAbilityParse, ability.spell_id, () => new Map<number, number>());
        byParse.set(member.parse_index, (byParse.get(member.parse_index) ?? 0) + ability.damage);
      }
    }
    const distinctParses = new Set(cluster.map(member => member.parse_index)).size;
    return [...damageByAbilityParse.entries()]
      .filter(([, byParse]) => byParse.size >= distinctParses * MEMBER_MAJORITY_FRAC)
      .map(([spell_id, byParse]) => {
        const perParseDamage = [...byParse.values()];
        const [min = 0, max = 0] = extent(perParseDamage);
        return {
          spell_id,
          avg_damage: Math.round((mean(perParseDamage) ?? 0)),
          min_damage: Math.round(min),
          max_damage: Math.round(max),
        };
      })
      .sort((a, b) => b.avg_damage - a.avg_damage)
      .slice(0, ABILITY_BREAKDOWN_TOP_N);
  }

  private majorityRefGameId(cluster: ParseDefWindow[]): number | null {
    const refs = cluster.map(member => member.ref_game_id).filter(ref => ref != null);
    return refs.length ? mode(refs) : null;
  }

  protected clusterDefensiveWindows(windows: ParseDefWindow[], sampleCount: number): BurstWindow[] {
    if (!windows.length) return [];
    const byDefensive = group(windows, window => window.defensive_name);

    const minParses = Math.max(2, sampleCount * CONSENSUS_FRAC);
    const result: BurstWindow[] = [];
    for (const [defensiveName, group] of byDefensive.entries()) {
      for (const cluster of groupByTime(group, CLUSTER_MERGE_S)) {
        const distinctParses = new Set(cluster.map(member => member.parse_index)).size;
        const clusterHead = cluster[0];
        if (!clusterHead || distinctParses < minParses) continue;
        const damages = cluster.map(member => member.window_damage);

        result.push({
          time_s: medianOr(cluster.map(member => member.time_s), 0),
          ...this.clusterDamageStats(damages),
          window_length_s: avgOr(cluster.map(member => member.window_length_s), 0),
          defensive_name: defensiveName,
          spell_id: clusterHead.spell_id,
          common_cds: [defensiveName],
          ref_game_id: this.majorityRefGameId(cluster),
          ability_breakdown: this.clusterAbilityBreakdown(cluster),
        });
      }
    }
    return result.sort((a, b) => a.time_s - b.time_s);
  }

  /** Aggregate per-parse summaries into the per-defensive benchmarks. */
  protected aggregateDefensiveBenchmarks(
    perParseSummaries: ParseDefensiveSummary[][],
    defensives: RulebookDefensive[],
  ): Record<string, PerDefensiveBenchmark> {
    const byName = group(perParseSummaries.flat(), summary => summary.name);

    // Every sampled parse contributes one array, so the count is the total-parse use-share denominator.
    const totalParses = perParseSummaries.length;
    const perDefensiveBenchmarks: Record<string, PerDefensiveBenchmark> = {};
    // Iterate the rulebook defensives so the name, cooldown, and spell id come from one source.
    for (const defensive of defensives) {
      const summaries = byName.get(defensive.name);
      if (!summaries?.length) continue; // no sampled parse used this defensive
      perDefensiveBenchmarks[defensive.name] = this.castCadence.buildCadenceBenchmark(summaries, defensive.cooldown, totalParses);
    }
    return perDefensiveBenchmarks;
  }
}
