import { Injectable, inject } from '@angular/core';
import { WclApiService } from '../../../../core/wcl/wcl-api-service';
import { DataFileApiService } from '../../../../core/data-files/data-file-api-service';
import { TopParseSelection } from '../../../../core/wcl/wcl.models';
import { RulebookCooldown, RulebookDefensive, RulebookRule } from '../../../../domain/rulebook/rulebook.models';
import { PerCdBenchmark } from '../../../../domain/encounter/encounter.models';
import { group, quantile } from 'd3-array';
import {
  round, avgOr, stddevOr, castEfficiencyPct, closestToZero,
} from '../../../../domain/analysis/analysis-math';
import { HoldWindow } from '../../../../domain/analysis/hold-targets-service';
import { WclProjectionsService, TimedEvent } from '../../../../domain/analysis/wcl-projections-service';
import { BenchPipelineService, BenchParse } from '../../../../domain/analysis/bench-pipeline-service';
import { DataSource } from '../../../../core/data-source/data-source';
import { Result } from '../../../../core/http/result';
import { RotationRuleEngineService, BenchedRule, RuleSample, MIN_MEASURED_PARSES } from '../domain/rotation-rule-engine-service';
import { RuleContextService } from '../domain/rotation-rules/rule-context-service';
import { RotationBloodlustService } from '../domain/rotation-bloodlust-service';
import { RotationBench } from './rotation-data-source';
import { HoldTargetsService } from '../../../../domain/analysis/hold-targets-service';
import { CastCadenceService } from '../../../../domain/analysis/cast-cadence-service';

/** The rule engine's own floor, so an encounter never benches a parse count every rule band would then reject. */
const MIN_PARSE_COUNT = MIN_MEASURED_PARSES;
/** BL window: a CD counts as aligned if cast 30s before to 55s after BL start. */
const BL_WINDOW_BEFORE_S = 30;
const BL_WINDOW_AFTER_S = 55;
/** p90 of pooled cast gaps is the downtime floor. */
const DOWNTIME_PERCENTILE = 0.9;
const DEFAULT_DOWNTIME_THRESHOLD_S = 1.5;

export interface CdSummary {
  name: string;
  total_uses: number;
  first_cast_s: number | null;
  bl_aligned: boolean;
  bl_offset_s: number | null;
  cast_times_s: number[];
  hold_windows: HoldWindow[];
  cast_pattern: 'hold' | 'on_cooldown';
  fight_duration_s: number;
}

/** One parse's contribution for each judged rule, index-aligned with the rules. */
export type ParseRuleSamples = RuleSample[];

interface ParseRotation {
  summaries: CdSummary[];
  gapListS: number[];
  durationS: number;
  ruleSamples: ParseRuleSamples;
}

interface RotationPlan {
  cooldowns: RulebookCooldown[];
  defensives: RulebookDefensive[];
  judgeable: RulebookRule[];
}

@Injectable({ providedIn: 'root' })
export class RotationTransformService implements DataSource<RotationBench> {
  private readonly holdTargets = inject(HoldTargetsService);
  private readonly castCadence = inject(CastCadenceService);
  private readonly bloodlust = inject(RotationBloodlustService);
  private readonly ruleEngine = inject(RotationRuleEngineService);
  private readonly ruleContexts = inject(RuleContextService);
  private readonly benchPipeline = inject(BenchPipelineService);
  private readonly wclProjections = inject(WclProjectionsService);
  private readonly wclApi = inject(WclApiService);
  private readonly dataFiles = inject(DataFileApiService);

  async getBench(spec: string, encounterId: number, selection?: TopParseSelection): Promise<Result<RotationBench>> {
    return this.benchPipeline.benchFromTopParses(this.wclApi, { spec, encounterId, selection }, {
      logSource: 'RotationTransformService',
      errorId: 'rotation.bench',
      minSamples: MIN_PARSE_COUNT,
      noRankingsMessage: 'No top parses for this encounter.',
      tooFewParsesMessage: usable =>
        `Only ${usable} usable top parse(s) for this encounter; ${MIN_PARSE_COUNT} are needed to bench it.`,
      rulebook: {
        dataFiles: this.dataFiles,
        plan: (rulebook): RotationPlan | null => rulebook.major_cooldowns.length
          ? {
            cooldowns: rulebook.major_cooldowns,
            defensives: rulebook.defensives,
            judgeable: this.ruleEngine.judgeableRules(rulebook.rules),
          }
          : null,
        missingMessage: 'No rulebook cooldowns for this spec.',
      },
      iconSpellIds: bench => Object.values(bench.cd_spell_ids),
      parse: (parse, plan) => this.parseRotation(parse, plan.cooldowns, plan.judgeable),
      bench: ({ parses }, plan) => {
        const { downtimeThresholdS, topAvgEfficiency, topEfficiencyStddev } = this.computeEfficiencyThresholds(parses);
        return {
          downtime_threshold_s: downtimeThresholdS,
          top_avg_efficiency: topAvgEfficiency,
          top_efficiency_stddev: topEfficiencyStddev,
          per_cd_benchmarks: this.aggregateCdBenchmarks(parses.map(parse => parse.summaries), plan.cooldowns),
          major_cooldowns: plan.cooldowns,
          rules: this.benchRules(plan.judgeable, parses.map(parse => parse.ruleSamples)),
          cd_spell_ids: this.benchPipeline.spellIdsByName([...plan.cooldowns, ...plan.defensives]),
        };
      },
    });
  }

  protected benchRules(rules: RulebookRule[], perParse: ParseRuleSamples[]): BenchedRule[] {
    return rules.map((rule, i) => ({
      rule,
      ...(rule.condition
        ? this.ruleEngine.ruleBand(rule.condition, perParse.map(samples => samples[i] ?? { values: [], unmeasuredOut: 0 }))
        : { band: null, sample_count: 0 }),
    }));
  }

  private async parseRotation(
    { ranking, fight, player }: BenchParse, cooldowns: RulebookCooldown[], rules: RulebookRule[],
  ): Promise<ParseRotation> {
    const [casts, buffs, enemyAuras, damage] = await Promise.all([
      this.wclApi.getAllEvents(ranking.report_code, fight.id, 'Casts', fight.startTime, fight.endTime, player.id, true),
      this.wclApi.getAllEvents(ranking.report_code, fight.id, 'Buffs', fight.startTime, fight.endTime, player.id),
      // Same shape and cost as the runtime fetch: raid-wide, so only for a spec that reads enemy auras.
      this.ruleEngine.rulesNeed(rules, 'enemyAuras')
        ? this.wclApi.getAllEvents(ranking.report_code, fight.id, 'Debuffs', fight.startTime, fight.endTime, undefined, false, 'Enemies')
        : Promise.resolve([]),
      // Target health rides on the damage rows, and only the resource-bearing form carries it.
      this.ruleEngine.rulesNeed(rules, 'damage')
        ? this.wclApi.getAllEvents(ranking.report_code, fight.id, 'DamageDone', fight.startTime, fight.endTime, player.id,
          this.ruleEngine.rulesNeed(rules, 'targetHealth'))
        : Promise.resolve([]),
    ]);

    const fightDurS = this.wclProjections.relativeS(fight.endTime, fight.startTime);
    const castsTimed = this.wclProjections.withRelativeS(casts, fight.startTime);
    const buffsTimed = this.wclProjections.withRelativeS(buffs, fight.startTime);
    const blTimeS = this.bloodlust.detectBloodlust(buffsTimed);
    const ruleCtx = this.ruleContexts.buildRuleContext({
      casts: castsTimed, buffs: buffsTimed, damage: this.wclProjections.withRelativeS(damage, fight.startTime),
      debuffs: this.wclProjections.withRelativeS(enemyAuras.filter(event => event.sourceID === player.id), fight.startTime),
      fightDurationS: fightDurS,
    });
    return {
      summaries: this.summarizeCooldownCasts(castsTimed, cooldowns, fightDurS, blTimeS),
      gapListS: this.castGapListS(castsTimed),
      durationS: fightDurS,
      ruleSamples: rules.map(rule => (rule.condition ? this.ruleEngine.sampleRule(rule.condition, ruleCtx) : { values: [], unmeasuredOut: 0 })),
    };
  }

  protected summarizeCooldownCasts(
    castEvents: TimedEvent[], cooldowns: RulebookCooldown[],
    fightDurS: number, blTimeS: number | null,
  ): CdSummary[] {
    return cooldowns.map(cooldown => {
      const castTimesS = castEvents
        .filter(cast => cast.type === 'cast' && cast.abilityGameID === cooldown.spell_id)
        .map(cast => cast.atS)
        .sort((a, b) => a - b);

      let blAligned = false;
      let blOffsetS: number | null = null;
      if (blTimeS != null && castTimesS.length) {
        const windowOffsets = castTimesS
          .filter(timeS => blTimeS - BL_WINDOW_BEFORE_S <= timeS && timeS <= blTimeS + BL_WINDOW_AFTER_S)
          .map(timeS => timeS - blTimeS);
        blAligned = windowOffsets.length > 0;
        if (windowOffsets.length) blOffsetS = round(closestToZero(windowOffsets));
      }

      const holdWindows = this.holdTargets.detectHoldWindows(castTimesS, cooldown.cooldown);

      return {
        name: cooldown.name,
        total_uses: castTimesS.length,
        first_cast_s: castTimesS[0] != null ? round(castTimesS[0]) : null,
        bl_aligned: blAligned,
        bl_offset_s: blOffsetS,
        cast_times_s: castTimesS.map(timeS => round(timeS, 2)),
        hold_windows: holdWindows,
        cast_pattern: holdWindows.length ? 'hold' : 'on_cooldown',
        fight_duration_s: fightDurS,
      };
    });
  }

  protected castGapListS(castEvents: TimedEvent[]): number[] {
    const completed = castEvents.filter(event => event.type === 'cast').sort((a, b) => a.atS - b.atS);
    const gaps: number[] = [];
    let prev: TimedEvent | undefined;
    for (const event of completed) {
      if (prev) gaps.push(round(event.atS - prev.atS, 3));
      prev = event;
    }
    return gaps.sort((a, b) => a - b);
  }

  protected buildCdBenchmark(entries: CdSummary[], effectiveCd: number): PerCdBenchmark {
    const users = entries.filter(entry => entry.total_uses > 0);
    const blOffsets = entries.map(entry => entry.bl_offset_s).filter((value): value is number => value != null);
    const blCount = entries.filter(entry => entry.bl_aligned).length;

    return {
      ...this.castCadence.buildCadenceBenchmark(users, effectiveCd, entries.length),
      avg_bl_offset_s: avgOr(blOffsets, null),
      stddev_bl_offset_s: stddevOr(blOffsets, null),
      bl_pct: entries.length ? Math.round((blCount / entries.length) * 100) : 0,
    };
  }

  protected computeEfficiencyThresholds(
    parses: { gapListS: number[]; durationS: number }[],
  ): { downtimeThresholdS: number; topAvgEfficiency: number; topEfficiencyStddev: number } {
    const allGaps = parses.flatMap(parse => parse.gapListS).sort((a, b) => a - b);
    let downtimeThresholdS = DEFAULT_DOWNTIME_THRESHOLD_S;
    if (allGaps.length) {
      downtimeThresholdS = quantile(allGaps, DOWNTIME_PERCENTILE) ?? DEFAULT_DOWNTIME_THRESHOLD_S;
    }
    const efficiencies: number[] = [];
    for (const { gapListS, durationS } of parses) {
      if (gapListS.length && durationS > 0) {
        const downtimeS = gapListS.filter(gap => gap > downtimeThresholdS).reduce((sum, gap) => sum + gap, 0);
        efficiencies.push(round(castEfficiencyPct(downtimeS, durationS)));
      }
    }
    return {
      downtimeThresholdS: round(downtimeThresholdS, 3),
      topAvgEfficiency: avgOr(efficiencies, 0),
      topEfficiencyStddev: stddevOr(efficiencies, 0),
    };
  }

  protected aggregateCdBenchmarks(
    perParse: CdSummary[][], cooldowns: RulebookCooldown[],
  ): Record<string, PerCdBenchmark> {
    const cdSecondsByName = new Map(cooldowns.map(cooldown => [cooldown.name, cooldown.cooldown]));
    const byCd = group(perParse.flat(), summary => summary.name);
    const result: Record<string, PerCdBenchmark> = {};
    for (const [name, entries] of byCd.entries()) {
      result[name] = this.buildCdBenchmark(entries, cdSecondsByName.get(name) ?? 90);
    }
    return result;
  }
}
