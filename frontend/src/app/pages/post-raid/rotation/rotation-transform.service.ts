import { Injectable, inject } from '@angular/core';
import { WclApiService } from '../../../core/services/wcl-api';
import { DataFileApiService } from '../../../core/services/data-file-api';
import { RulebookCooldown, RulebookDefensive, RulebookRule } from '../../../core/models/rulebook.models';
import { PerCdBenchmark, UsesPerMin } from '../../../core/models/encounter.models';
import { mean, deviation, group, quantile } from 'd3-array';
import { round, avgOr, stddevOr, medianOr, castGaps } from '../../../shared/analysis/analysis-math';
import {
  HoldWindow, HOLD_CONSENSUS_FRAC, buildHoldTargets, detectHoldWindows,
} from '../../../shared/analysis/hold-targets';
import { TimedEvent, abilityIcons, relativeS, withRelativeS } from '../../../shared/analysis/wcl-projections';
import { BenchParse, benchFromTopParses } from '../../../shared/analysis/bench-pipeline';
import { DataSource } from '../../../core/data-source/data-source';
import { Result, missing } from '../../../core/result';
import {
  BenchedRule, RuleSample, MIN_MEASURED_PARSES, buildRuleContext, sampleRule, ruleBand, judgeableRules, rulesNeed,
} from './rotation-rules';
import { detectBloodlust } from './rotation-bloodlust';
import { RotationBench } from './rotation-data-source';


/** The rule engine's own floor, so an encounter never benches a parse count every rule band would then reject. */
const MIN_PARSE_COUNT = MIN_MEASURED_PARSES;
/** BL window: a CD counts as aligned if cast 30s before to 55s after BL start. */
const BL_WINDOW_BEFORE_S = 30;
const BL_WINDOW_AFTER_S = 55;
/** p90 of pooled cast gaps is the downtime floor. */
const DOWNTIME_PERCENTILE = 0.9;
const DEFAULT_DOWNTIME_THRESHOLD_S = 1.5;

export function rotationCdSpellIds(cooldowns: RulebookCooldown[], defensives: RulebookDefensive[]): Record<string, number> {
  const map: Record<string, number> = {};
  for (const cooldown of cooldowns) if (cooldown.spell_id) map[cooldown.name] = cooldown.spell_id;
  for (const defensive of defensives) if (defensive.spell_id) map[defensive.name] = defensive.spell_id;
  return map;
}

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

export function summarizeCooldownCasts(
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
      if (windowOffsets.length) {
        blOffsetS = round(windowOffsets.reduce((best, offset) => (Math.abs(offset) < Math.abs(best) ? offset : best)));
      }
    }

    const holdWindows = detectHoldWindows(castTimesS, cooldown.cooldown);

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

export function castGapListS(castEvents: TimedEvent[]): number[] {
  const completed = castEvents.filter(event => event.type === 'cast').sort((a, b) => a.atS - b.atS);
  const gaps: number[] = [];
  let prev: TimedEvent | undefined;
  for (const event of completed) {
    if (prev) gaps.push(round(event.atS - prev.atS, 3));
    prev = event;
  }
  return gaps.sort((a, b) => a - b);
}

function benchUsesPerMin(entries: CdSummary[]): UsesPerMin {
  const usesPerMin: number[] = [];
  for (const entry of entries) {
    if (entry.fight_duration_s > 0 && entry.cast_times_s.length) {
      usesPerMin.push(round((entry.cast_times_s.length / entry.fight_duration_s) * 60, 3));
    }
  }
  if (!usesPerMin.length) return { avg: 0, stddev: 0 };
  return {
    avg: round((mean(usesPerMin) ?? 0), 3),
    stddev: round((deviation(usesPerMin) ?? 0), 3),
  };
}


export function buildCdBenchmark(entries: CdSummary[], effectiveCd: number): PerCdBenchmark {
  const firstCasts = entries.map(entry => entry.first_cast_s).filter((value): value is number => value != null);
  const gaps = castGaps(entries);
  const blOffsets = entries.map(entry => entry.bl_offset_s).filter((value): value is number => value != null);
  const blCount = entries.filter(entry => entry.bl_aligned).length;
  const usesPerMin = benchUsesPerMin(entries);
  const usedUses = entries.map(entry => entry.total_uses).filter(uses => uses > 0);

  return {
    sample_count: entries.length,
    used_sample_count: entries.filter(entry => entry.total_uses > 0).length,
    avg_first_cast_s: avgOr(firstCasts, 0),
    stddev_first_cast_s: stddevOr(firstCasts, 0),
    avg_gap_s: avgOr(gaps, null),
    stddev_gap_s: stddevOr(gaps, null),
    avg_bl_offset_s: avgOr(blOffsets, null),
    stddev_bl_offset_s: stddevOr(blOffsets, null),
    median_uses: medianOr(usedUses, 0),
    uses_per_min: usesPerMin,
    bl_pct: entries.length ? Math.round((blCount / entries.length) * 100) : 0,
    majority_hold: entries.filter(entry => entry.cast_pattern === 'hold').length >= entries.length * HOLD_CONSENSUS_FRAC,
    hold_targets: buildHoldTargets(entries, effectiveCd),
  };
}

export function computeEfficiencyThresholds(
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
      efficiencies.push(round(Math.max(0, (1 - downtimeS / durationS) * 100)));
    }
  }
  return {
    downtimeThresholdS: round(downtimeThresholdS, 3),
    topAvgEfficiency: avgOr(efficiencies, 0),
    topEfficiencyStddev: stddevOr(efficiencies, 0),
  };
}

export function aggregateCdBenchmarks(
  perParse: CdSummary[][], cooldowns: RulebookCooldown[],
): Record<string, PerCdBenchmark> {
  const cdSecondsByName = new Map(cooldowns.map(cooldown => [cooldown.name, cooldown.cooldown]));
  const byCd = group(perParse.flat(), summary => summary.name);
  const result: Record<string, PerCdBenchmark> = {};
  for (const [name, entries] of byCd.entries()) {
    result[name] = buildCdBenchmark(entries, cdSecondsByName.get(name) ?? 90);
  }
  return result;
}

/** One parse's contribution for each judged rule, index-aligned with the rules. */
export type ParseRuleSamples = RuleSample[];

interface ParseRotation {
  summaries: CdSummary[];
  gapListS: number[];
  durationS: number;
  ruleSamples: ParseRuleSamples;
}

export function benchRules(rules: RulebookRule[], perParse: ParseRuleSamples[]): BenchedRule[] {
  return rules.map((rule, i) => ({
    rule,
    ...(rule.condition
      ? ruleBand(rule.condition, perParse.map(samples => samples[i] ?? { values: [], unmeasuredOut: 0 }))
      : { band: null, sample_count: 0 }),
  }));
}

@Injectable({ providedIn: 'root' })
export class RotationTransformService implements DataSource<RotationBench> {
  private readonly wclApi = inject(WclApiService);
  private readonly dataFiles = inject(DataFileApiService);

  async getBench(spec: string, encounterId: number, partition?: number | null): Promise<Result<RotationBench>> {
    const rulebookResult = await this.dataFiles.getRulebook(spec);
    if (!rulebookResult.ok) return rulebookResult;
    const rulebook = rulebookResult.value;
    const cooldowns = rulebook.major_cooldowns;
    if (!cooldowns.length) return missing('No rulebook cooldowns for this spec.');
    const defensives = rulebook.defensives;
    const judgeable = judgeableRules(rulebook.rules);

    return benchFromTopParses(this.wclApi, { spec, encounterId, partition }, {
      logSource: 'RotationTransformService',
      errorId: 'rotation.bench',
      minSamples: MIN_PARSE_COUNT,
      noRankingsMessage: 'No top parses for this encounter.',
      tooFewParsesMessage: usable =>
        `Only ${usable} usable top parse(s) for this encounter; ${MIN_PARSE_COUNT} are needed to bench it.`,
      parse: parse => this.parseRotation(parse, cooldowns, judgeable),
      bench: async ({ encounterName, parses }) => {
        const { downtimeThresholdS, topAvgEfficiency, topEfficiencyStddev } = computeEfficiencyThresholds(parses);

        const cd_spell_ids = rotationCdSpellIds(cooldowns, defensives);
        return {
          spec,
          encounter_id: encounterId,
          encounter_name: encounterName,
          sample_count: parses.length,
          downtime_threshold_s: downtimeThresholdS,
          top_avg_efficiency: topAvgEfficiency,
          top_efficiency_stddev: topEfficiencyStddev,
          per_cd_benchmarks: aggregateCdBenchmarks(parses.map(parse => parse.summaries), cooldowns),
          major_cooldowns: cooldowns,
          rules: benchRules(judgeable, parses.map(parse => parse.ruleSamples)),
          cd_spell_ids,
          // A real icon for every cooldown + defensive by id, so the map is complete (no fallback).
          ability_icons: abilityIcons(await this.wclApi.getAbilities(Object.values(cd_spell_ids))),
        };
      },
    });
  }

  private async parseRotation(
    { ranking, fight, player }: BenchParse, cooldowns: RulebookCooldown[], rules: RulebookRule[],
  ): Promise<ParseRotation> {
    const [casts, buffs, enemyAuras, damage] = await Promise.all([
      this.wclApi.getAllEvents(ranking.report_code, fight.id, 'Casts', fight.startTime, fight.endTime, player.id, true),
      this.wclApi.getAllEvents(ranking.report_code, fight.id, 'Buffs', fight.startTime, fight.endTime, player.id),
      // Same shape and cost as the runtime fetch: raid-wide, so only for a spec that reads enemy auras.
      rulesNeed(rules, 'enemyAuras')
        ? this.wclApi.getAllEvents(ranking.report_code, fight.id, 'Debuffs', fight.startTime, fight.endTime, undefined, false, 'Enemies')
        : Promise.resolve([]),
      // Target health rides on the damage rows, and only the resource-bearing form carries it.
      rulesNeed(rules, 'damage')
        ? this.wclApi.getAllEvents(ranking.report_code, fight.id, 'DamageDone', fight.startTime, fight.endTime, player.id,
          rulesNeed(rules, 'targetHealth'))
        : Promise.resolve([]),
    ]);

    const fightDurS = relativeS(fight.endTime, fight.startTime);
    const castsTimed = withRelativeS(casts, fight.startTime);
    const buffsTimed = withRelativeS(buffs, fight.startTime);
    const blTimeS = detectBloodlust(buffsTimed);
    const ruleCtx = buildRuleContext({
      casts: castsTimed, buffs: buffsTimed, damage: withRelativeS(damage, fight.startTime),
      debuffs: withRelativeS(enemyAuras.filter(event => event.sourceID === player.id), fight.startTime),
      fightDurationS: fightDurS,
    });
    return {
      summaries: summarizeCooldownCasts(castsTimed, cooldowns, fightDurS, blTimeS),
      gapListS: castGapListS(castsTimed),
      durationS: fightDurS,
      ruleSamples: rules.map(rule => (rule.condition ? sampleRule(rule.condition, ruleCtx) : { values: [], unmeasuredOut: 0 })),
    };
  }
}
