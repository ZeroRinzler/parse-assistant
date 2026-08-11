import { Injectable, inject } from '@angular/core';
import { WclApiService } from '../../../core/services/wcl-api';
import { DataFileApiService } from '../../../core/services/data-file-api';
import { ParseRanking } from '../../../core/models/wcl.models';
import { RulebookCooldown, RulebookDefensive, RulebookRule } from '../../../core/models/rulebook.models';
import { PerCdBenchmark, UsesPerMin } from '../../../core/models/encounter.models';
import { logWarn } from '../../../core/log';
import { mean, median, deviation, quantile } from 'd3-array';
import { round, getOrInsert } from '../../../shared/analysis/analysis-math';
import {
  HoldWindow, HOLD_CONSENSUS_FRAC, buildHoldTargets, detectHoldWindows,
} from '../../../shared/analysis/hold-targets';
import { TimedEvent, abilityIcons, findParseActor, relativeS, toParseRankings, unwrapRankings, withRelativeS } from '../../../shared/analysis/wcl-projections';
import { DataSource } from '../../../core/data-source/data-source';
import { Result, LoadError, ok, missing } from '../../../core/result';
import { toLoadError } from '../../../core/http-load-error';
import {
  BenchedRule, RuleSample, MIN_MEASURED_PARSES, buildRuleContext, sampleRule, ruleBand, judgeableRules, rulesNeed,
} from './rotation-rules';
import { detectBloodlust } from './rotation-bloodlust';
import { RotationBench } from './rotation-data-source';

// Re-exported so call sites and specs can import it from this service.
export { toParseRankings } from '../../../shared/analysis/wcl-projections';

/** How many top parses to sample. */
const TOP_PARSE_COUNT = 10;
/** The rule engine's own floor, so an encounter never benches a parse count every rule band would then reject. */
const MIN_PARSE_COUNT = MIN_MEASURED_PARSES;
// Over-fetch so a private/unfetchable top parse can be backfilled by the next-best one.
const CANDIDATE_POOL_COUNT = TOP_PARSE_COUNT * 2;
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

    const holdWindows = detectHoldWindows(castTimesS, cooldown.cooldown ?? 90);

    return {
      name: cooldown.name,
      total_uses: castTimesS.length,
      first_cast_s: castTimesS.length ? round(castTimesS[0]) : null,
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
  for (let i = 1; i < completed.length; i++) gaps.push(round(completed[i].atS - completed[i - 1].atS, 3));
  return gaps.sort((a, b) => a - b);
}

function benchUsesPerMin(entries: CdSummary[]): UsesPerMin {
  const usesPerMin: number[] = [];
  for (const entry of entries) {
    if (entry.fight_duration_s > 0 && entry.cast_times_s.length) {
      usesPerMin.push(round((entry.cast_times_s.length / entry.fight_duration_s) * 60, 3));
    }
  }
  if (!usesPerMin.length) return { avg: 0, stddev: 0, min: 0, max: 0 };
  return {
    avg: round((mean(usesPerMin) ?? 0), 3),
    stddev: round((deviation(usesPerMin) ?? 0), 3),
    min: Math.min(...usesPerMin),
    max: Math.max(...usesPerMin),
  };
}


export function buildCdBenchmark(entries: CdSummary[], effectiveCd: number): PerCdBenchmark {
  const firstCasts = entries.map(entry => entry.first_cast_s).filter((value): value is number => value != null);
  const gaps: number[] = [];
  for (const entry of entries) {
    const times = entry.cast_times_s;
    for (let i = 1; i < times.length; i++) gaps.push(times[i] - times[i - 1]);
  }
  const blOffsets = entries.map(entry => entry.bl_offset_s).filter((value): value is number => value != null);
  const blCount = entries.filter(entry => entry.bl_aligned).length;
  const upmList = entries
    .filter(entry => entry.fight_duration_s > 0)
    .map(entry => entry.total_uses / (entry.fight_duration_s / 60));
  const usesPerMin = benchUsesPerMin(entries);
  const usedUses = entries.map(entry => entry.total_uses).filter(uses => uses > 0);

  return {
    sample_count: entries.length,
    used_sample_count: entries.filter(entry => entry.total_uses > 0).length,
    avg_first_cast_s: firstCasts.length ? round((mean(firstCasts) ?? 0)) : 0,
    stddev_first_cast_s: firstCasts.length ? round((deviation(firstCasts) ?? 0)) : 0,
    avg_gap_s: gaps.length ? round((mean(gaps) ?? 0)) : null,
    stddev_gap_s: gaps.length ? round((deviation(gaps) ?? 0)) : null,
    avg_bl_offset_s: blOffsets.length ? round((mean(blOffsets) ?? 0)) : null,
    stddev_bl_offset_s: blOffsets.length ? round((deviation(blOffsets) ?? 0)) : null,
    avg_uses: entries.length ? round(mean(entries.map(entry => entry.total_uses)) ?? 0) : 0,
    median_uses: usedUses.length ? round(median(usedUses) ?? 0) : 0,
    avg_uses_per_min: upmList.length ? round((mean(upmList) ?? 0), 2) : 0,
    uses_per_min: usesPerMin,
    bl_pct: entries.length ? Math.round((blCount / entries.length) * 100) : 0,
    majority_hold: entries.filter(entry => entry.cast_pattern === 'hold').length >= entries.length * HOLD_CONSENSUS_FRAC,
    hold_targets: buildHoldTargets(entries, effectiveCd),
  };
}

export function computeEfficiencyThresholds(
  gapLists: number[][], durations: number[],
): { downtimeThresholdS: number; topAvgEfficiency: number; topEfficiencyStddev: number } {
  const allGaps = gapLists.flat().sort((a, b) => a - b);
  let downtimeThresholdS = DEFAULT_DOWNTIME_THRESHOLD_S;
  if (allGaps.length) {
    downtimeThresholdS = quantile(allGaps, DOWNTIME_PERCENTILE) ?? DEFAULT_DOWNTIME_THRESHOLD_S;
  }
  const efficiencies: number[] = [];
  for (let i = 0; i < gapLists.length; i++) {
    const gaps = gapLists[i];
    const durationS = durations[i] ?? 0;
    if (gaps.length && durationS > 0) {
      const downtimeS = gaps.filter(gap => gap > downtimeThresholdS).reduce((sum, gap) => sum + gap, 0);
      efficiencies.push(round(Math.max(0, (1 - downtimeS / durationS) * 100)));
    }
  }
  return {
    downtimeThresholdS: round(downtimeThresholdS, 3),
    topAvgEfficiency: efficiencies.length ? round((mean(efficiencies) ?? 0)) : 0,
    topEfficiencyStddev: efficiencies.length ? round((deviation(efficiencies) ?? 0)) : 0,
  };
}

export function aggregateCdBenchmarks(
  perParse: CdSummary[][], cooldowns: RulebookCooldown[],
): Record<string, PerCdBenchmark> {
  const cdSecondsByName = new Map(cooldowns.map(cooldown => [cooldown.name, cooldown.cooldown ?? 90]));
  const byCd = new Map<string, CdSummary[]>();
  for (const summaries of perParse) {
    for (const summary of summaries) {
      getOrInsert(byCd, summary.name, () => []).push(summary);
    }
  }
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
  encounterName: string;
  ruleSamples: ParseRuleSamples;
}

export function benchRules(rules: RulebookRule[], perParse: ParseRuleSamples[]): BenchedRule[] {
  return rules.map((rule, i) => ({
    rule,
    ...ruleBand(rule.condition, perParse.map(samples => samples[i] ?? { values: [], unmeasuredOut: 0 })),
  }));
}

@Injectable({ providedIn: 'root' })
export class RotationTransformService implements DataSource<RotationBench> {
  private readonly wclApi = inject(WclApiService);
  private readonly dataFiles = inject(DataFileApiService);

  async getBench(spec: string, encounterId: number, partition?: number | null): Promise<Result<RotationBench, LoadError>> {
    const rulebookResult = await this.dataFiles.getRulebook(spec);
    if (!rulebookResult.ok) return rulebookResult;
    const rulebook = rulebookResult.value;
    const cooldowns = rulebook.major_cooldowns ?? [];
    if (!cooldowns.length) return missing('No rulebook cooldowns for this spec.');
    const defensives = rulebook.defensives ?? [];
    const judgeable = judgeableRules(rulebook.rules ?? []);

    try {
      const rankings = toParseRankings(unwrapRankings(await this.wclApi.getRankings(spec, encounterId, partition)), CANDIDATE_POOL_COUNT);
      if (!rankings.length) return missing('No top parses for this encounter.');

      const perParse: CdSummary[][] = [];
      const ruleSamples: ParseRuleSamples[] = [];
      const gapLists: number[][] = [];
      const durations: number[] = [];
      let encounterName = '';
      for (const ranking of rankings) {
        const parse = await this.computeParse(ranking, cooldowns, judgeable);
        if (!parse) continue;
        perParse.push(parse.summaries);
        ruleSamples.push(parse.ruleSamples);
        gapLists.push(parse.gapListS);
        durations.push(parse.durationS);
        encounterName ||= parse.encounterName;
        if (perParse.length >= TOP_PARSE_COUNT) break;
      }
      if (perParse.length < MIN_PARSE_COUNT) {
        return missing(`Only ${perParse.length} usable top parse(s) for this encounter; ${MIN_PARSE_COUNT} are needed to bench it.`);
      }

      const { downtimeThresholdS, topAvgEfficiency, topEfficiencyStddev } = computeEfficiencyThresholds(gapLists, durations);

      const cd_spell_ids = rotationCdSpellIds(cooldowns, defensives);
      return ok({
        spec,
        encounter_id: encounterId,
        encounter_name: encounterName,
        sample_count: perParse.length,
        avg_duration_s: durations.length ? round((mean(durations) ?? 0)) : 0,
        downtime_threshold_s: downtimeThresholdS,
        top_avg_efficiency: topAvgEfficiency,
        top_efficiency_stddev: topEfficiencyStddev,
        per_cd_benchmarks: aggregateCdBenchmarks(perParse, cooldowns),
        major_cooldowns: cooldowns,
        rules: benchRules(judgeable, ruleSamples),
        cd_spell_ids,
        // A real icon for every cooldown + defensive by id, so the map is complete (no fallback).
        ability_icons: abilityIcons(await this.wclApi.getAbilities(Object.values(cd_spell_ids))),
      });
    } catch (cause) {
      logWarn(`RotationTransformService.getBench ${spec}:${encounterId}`, cause);
      return toLoadError(cause, 'rotation.bench');
    }
  }

  private async computeParse(
    ranking: ParseRanking, cooldowns: RulebookCooldown[], rules: RulebookRule[],
  ): Promise<ParseRotation | null> {
    try {
      const report = await this.wclApi.getReport(ranking.report_code);
      const fight = report.fights.find(entry => entry.id === ranking.fight_id);
      const player = findParseActor(report.masterData?.actors, ranking);
      if (!fight || !player) return null;

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
        encounterName: fight.name ?? '',
        ruleSamples: rules.map(rule => sampleRule(rule.condition, ruleCtx)),
      };
    } catch (err) {
      logWarn(`RotationTransformService parse ${ranking.report_code}:${ranking.fight_id}`, err);
      return null;
    }
  }
}
