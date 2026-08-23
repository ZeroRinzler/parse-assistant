import { Injectable, inject } from '@angular/core';
import { WclApiService } from '../../../../core/wcl/wcl-api-service';
import { DataFileApiService } from '../../../../core/data-files/data-file-api-service';
import { TopParseSelection } from '../../../../core/wcl/wcl.models';
import { RulebookCooldown, RulebookDefensive } from '../../../../domain/rulebook/rulebook.models';
import { BurstWindow } from '../../../../domain/analysis/analysis.models';
import { Result } from '../../../../core/http/result';
import { mean, median, deviation, extent, greatest, quantile, rollup, rollups } from 'd3-array';
import { round, groupByTime, getOrInsert } from '../../../../domain/analysis/analysis-math';
import { WclProjectionsService, TimedEvent } from '../../../../domain/analysis/wcl-projections-service';
import { BenchPipelineService, BenchParse } from '../../../../domain/analysis/bench-pipeline-service';
import { DataSource } from '../../../../core/data-source/data-source';
import { BurstBench } from './burst-data-source';

const CLUSTER_MIN_FRAC = 0.4;
const MEMBER_MAJORITY_FRAC = 0.5;
const CLUSTER_MERGE_S = 15;

export interface BurstDetectorTuning {
  binS: number;
  rollBins: number;
  thresholdMult: number;
  rateQuantile: number;
  mergeGapBins: number;
  significancePct: number;
}

export const DEFAULT_BURST_TUNING: BurstDetectorTuning = {
  binS: 1,
  rollBins: 3,
  thresholdMult: 1.6,
  rateQuantile: 0.66,
  mergeGapBins: 2,
  significancePct: 0.015,
};

interface CdTiming { name: string; castTimesS: number[]; }

export interface ParseWindow {
  time_s: number;
  window_length_s: number;
  window_damage: number;
  active_cds: string[];
  ability_breakdown: { spell_id: number; damage: number; casts: number; is_passive: boolean }[];
  /** Index of the parse this window came from, so clustering counts DISTINCT parses. */
  parse_index: number;
}

/** Bin-index span, inclusive on both ends. */
interface BinRun {
  startBin: number;
  endBin: number;
}

/** `[atS, damage, abilityGameID]`, fight-relative. */
type DamageHit = [number, number, number];

/** `[atS, abilityGameID]`, fight-relative. */
type CastRow = [number, number];

export interface ParseWindowScan {
  damage: TimedEvent[];
  fightLenS: number;
  timings: CdTiming[];
  casts: TimedEvent[];
  abilityNames: Map<number, string>;
}

interface RunWindowContext {
  hits: DamageHit[];
  total: number;
  binCount: number;
  damagePerBin: number[];
  timings: CdTiming[];
  castRows: CastRow[];
  nameOf: (spellId: number) => string;
  castNamesInParse: Set<string>;
  tuning: BurstDetectorTuning;
}

interface BurstPlan {
  cooldowns: RulebookCooldown[];
  defensives: RulebookDefensive[];
}

@Injectable({ providedIn: 'root' })
export class BurstTransformService implements DataSource<BurstBench> {
  private readonly benchPipeline = inject(BenchPipelineService);
  private readonly wclProjections = inject(WclProjectionsService);
  private readonly wclApi = inject(WclApiService);
  private readonly dataFiles = inject(DataFileApiService);

  async getBench(spec: string, encounterId: number, selection?: TopParseSelection): Promise<Result<BurstBench>> {
    return this.benchPipeline.benchFromTopParses(this.wclApi, { spec, encounterId, selection }, {
      logSource: 'BurstTransformService',
      errorId: 'burst.bench',
      noRankingsMessage: 'Not yet ingested.',
      rulebook: {
        dataFiles: this.dataFiles,
        plan: (rulebook): BurstPlan | null => rulebook.major_cooldowns.length
          ? { cooldowns: rulebook.major_cooldowns, defensives: rulebook.defensives }
          : null,
        missingMessage: 'Not yet ingested.',
      },
      iconSpellIds: bench => [
        ...Object.values(bench.cd_spell_ids),
        ...bench.windows.flatMap(window => window.ability_breakdown.map(ability => ability.spell_id)),
      ],
      parse: (parse, plan) => this.parseWindows(parse, plan.cooldowns),
      bench: ({ parses }, plan) => {
        const allWindows = parses.flatMap(
          (windows, parseIndex) => windows.map(window => ({ ...window, parse_index: parseIndex })));
        return {
          windows: this.clusterParseWindows(allWindows, parses.length),
          cd_spell_ids: this.benchPipeline.spellIdsByName([...plan.cooldowns, ...plan.defensives]),
        };
      },
    });
  }

  private async parseWindows({ ranking, report, fight, player }: BenchParse, cooldowns: RulebookCooldown[]): Promise<ParseWindow[]> {
    // Names only, to attribute casts by ability name inside a parse window.
    const abilityNames = new Map<number, string>(
      (report.masterData?.abilities ?? []).map(ability => [ability.gameID, ability.name]),
    );
    const [casts, damage] = await Promise.all([
      this.wclApi.getAllEvents(ranking.report_code, fight.id, 'Casts', fight.startTime, fight.endTime, player.id),
      this.wclApi.getAllEvents(ranking.report_code, fight.id, 'DamageDone', fight.startTime, fight.endTime, player.id),
    ]);

    const castsTimed = this.wclProjections.withRelativeS(casts, fight.startTime);
    return this.findParseWindows({
      damage: this.wclProjections.withRelativeS(damage, fight.startTime), fightLenS: this.wclProjections.relativeS(fight.endTime, fight.startTime),
      timings: this.cdTimings(castsTimed, cooldowns), casts: castsTimed, abilityNames,
    });
  }

  protected cdTimings(casts: TimedEvent[], cooldowns: RulebookCooldown[]): CdTiming[] {
    return cooldowns.map(cooldown => ({
      name: cooldown.name,
      castTimesS: casts
        .filter(cast => cast.type === 'cast' && cast.abilityGameID === cooldown.spell_id)
        .map(cast => cast.atS)
        .sort((a, b) => a - b),
    }));
  }

  /** A hit before/after the fight span clamps into the first/last bin. */
  private bucketDamagePerBin(hits: DamageHit[], binCount: number, binS: number): number[] {
    const dmgByBin = new Map<number, number>();
    for (const [atS, hitDamage] of hits) {
      const binIndex = Math.min(Math.max(Math.floor(atS / binS), 0), binCount - 1);
      dmgByBin.set(binIndex, (dmgByBin.get(binIndex) ?? 0) + hitDamage);
    }
    return Array.from({ length: binCount }, (_, binIndex) => dmgByBin.get(binIndex) ?? 0);
  }

  private forwardRollingDamage(damagePerBin: number[], rollBins: number): number[] {
    return damagePerBin.map((_, binIndex) =>
      damagePerBin.slice(binIndex, binIndex + rollBins).reduce((sum, dmg) => sum + dmg, 0));
  }

  // A bin is dense at rolling damage >= densityThreshold (strict); runs bridge across up to mergeGapBins sub-threshold bins.
  private detectDenseRuns(rollingDamage: number[], densityThreshold: number, mergeGapBins: number): BinRun[] {
    const denseRuns: BinRun[] = [];
    let runStartBin = -1;
    let runEndBin = -1;
    let subThresholdBins = 0;
    for (const [binIndex, damage] of rollingDamage.entries()) {
      if (damage >= densityThreshold) {
        if (runStartBin < 0) runStartBin = binIndex;
        runEndBin = binIndex;
        subThresholdBins = 0;
      } else if (runStartBin >= 0) {
        subThresholdBins += 1;
        if (subThresholdBins > mergeGapBins) {
          denseRuns.push({ startBin: runStartBin, endBin: runEndBin });
          runStartBin = -1;
        }
      }
    }
    if (runStartBin >= 0) denseRuns.push({ startBin: runStartBin, endBin: runEndBin });
    return denseRuns;
  }

  // Snaps to the bins that actually carry damage: the rolling rate can flag up to rollBins-1 damage-free bins before a burst.
  private trimRunToDamage(run: BinRun, damagePerBin: number[]): BinRun | null {
    let windowStartBin = run.startBin;
    let windowEndBin = run.endBin;
    while (windowStartBin <= windowEndBin && damagePerBin[windowStartBin] === 0) windowStartBin++;
    while (windowEndBin >= windowStartBin && damagePerBin[windowEndBin] === 0) windowEndBin--;
    if (windowStartBin > windowEndBin) return null;
    return { startBin: windowStartBin, endBin: windowEndBin };
  }

  // Casts are attributed by ability NAME because a damage event's id often differs from the cast id.
  private windowAbilityBreakdown(
    windowHits: DamageHit[],
    castRows: CastRow[],
    startS: number,
    endS: number,
    nameOf: (spellId: number) => string,
    castNamesInParse: Set<string>,
  ): ParseWindow['ability_breakdown'] {
    const byAbility = new Map<number, number>();
    // Normalize before grouping so raw ids that fold to one spell (melee, synthetic negatives) sum, not split into rows.
    for (const [, dmg, abilityId] of windowHits) if (abilityId) {
      const spellId = this.wclProjections.normalizeAbilityId(abilityId);
      byAbility.set(spellId, (byAbility.get(spellId) ?? 0) + dmg);
    }

    const castsByName = new Map<string, number>();
    for (const [atS, abilityId] of castRows) {
      if (atS >= startS && atS < endS) castsByName.set(nameOf(abilityId), (castsByName.get(nameOf(abilityId)) ?? 0) + 1);
    }

    return [...byAbility.entries()]
      .sort((a, b) => b[1] - a[1]).slice(0, 6)
      .map(([spell_id, dmg]) => ({
        spell_id,
        damage: dmg,
        casts: castsByName.get(nameOf(spell_id)) ?? 0,
        is_passive: !castNamesInParse.has(nameOf(spell_id)),
      }));
  }

  // Windows are the parse's damage-density bursts, not cooldown-duration spans.
  protected findParseWindows(scan: ParseWindowScan, tuning: BurstDetectorTuning = DEFAULT_BURST_TUNING): ParseWindow[] {
    const { damage, fightLenS, timings, casts, abilityNames } = scan;
    const hits = damage
      .filter(event => event.type === 'damage' && (event.amount ?? 0) + (event.absorbed ?? 0) > 0)
      .map(event => [event.atS, (event.amount ?? 0) + (event.absorbed ?? 0), event.abilityGameID] as DamageHit)
      .sort((a, b) => a[0] - b[0]);
    if (!hits.length || fightLenS <= 0) return [];
    const total = hits.reduce((sum, hit) => sum + hit[1], 0);
    if (!total) return [];

    const binCount = Math.ceil(fightLenS / tuning.binS);
    if (binCount < 2) return [];
    const damagePerBin = this.bucketDamagePerBin(hits, binCount, tuning.binS);
    const rollingDamage = this.forwardRollingDamage(damagePerBin, tuning.rollBins);

    // Threshold floors at the rateQuantile bin so a spiky parse must beat its own typical bin, not just its mean.
    const meanRollingDamage = (total / binCount) * tuning.rollBins;
    const densityThreshold = Math.max(
      tuning.thresholdMult * meanRollingDamage, quantile(rollingDamage, tuning.rateQuantile) ?? 0);

    const denseRuns = this.detectDenseRuns(rollingDamage, densityThreshold, tuning.mergeGapBins);
    if (!denseRuns.length) return [];

    const castRows = casts
      .filter(event => event.type === 'cast' && event.abilityGameID)
      .map(event => [event.atS, event.abilityGameID] as CastRow);
    const nameOf = (spellId: number): string => abilityNames.get(spellId) ?? `Spell ${spellId}`;
    // A name absent here is passive (proc/auto/pet damage), not merely uncast within this window.
    const castNamesInParse = new Set(castRows.map(([, abilityId]) => nameOf(abilityId)));

    const windows: ParseWindow[] = [];
    const context: RunWindowContext = {
      hits, total, binCount, damagePerBin, timings, castRows, nameOf, castNamesInParse, tuning,
    };
    for (const run of denseRuns) {
      const window = this.windowFromRun(run, context);
      if (window) windows.push(window);
    }
    return windows.sort((a, b) => a.time_s - b.time_s);
  }

  private windowFromRun(run: BinRun, context: RunWindowContext): ParseWindow | null {
    const { hits, total, binCount, damagePerBin, timings, castRows, nameOf, castNamesInParse, tuning } = context;
    const trimmed = this.trimRunToDamage(run, damagePerBin);
    if (!trimmed) return null;
    const windowStartS = trimmed.startBin * tuning.binS;
    const windowEndS = (trimmed.endBin + 1) * tuning.binS;
    // The fight-closing window counts the fight-end hit bucketDamagePerBin clamps into the last bin; interior windows stay half-open.
    const closesFight = trimmed.endBin === binCount - 1;
    const windowHits = hits.filter(hit => hit[0] >= windowStartS && (closesFight ? hit[0] <= windowEndS : hit[0] < windowEndS));
    const windowDmg = windowHits.reduce((sum, hit) => sum + hit[1], 0);
    if (!windowDmg || windowDmg / total < tuning.significancePct) return null;
    return {
      time_s: round(windowStartS),
      window_length_s: round(windowEndS - windowStartS),
      window_damage: windowDmg,
      // Attribute (never bound by) the cooldowns whose cast lands inside the window.
      active_cds: timings
        .filter(timing => timing.castTimesS.some(castS => castS >= windowStartS && castS < windowEndS))
        .map(timing => timing.name),
      ability_breakdown: this.windowAbilityBreakdown(windowHits, castRows, windowStartS, windowEndS, nameOf, castNamesInParse),
      parse_index: 0, // stamped once the parse is accepted
    };
  }

  /** Keep each parse's biggest window (by window_damage), so a cluster counts DISTINCT parses. */
  private dedupeByParse(cluster: ParseWindow[]): ParseWindow[] {
    const biggest = rollup(cluster, windows => greatest(windows, window => window.window_damage), window => window.parse_index);
    return [...biggest.values()].filter(window => window != null);
  }

  /** Keeps an ability only when a majority of the cluster's parses used it, so a single parse's pet cannot invent a row. */
  private clusterAbilityBreakdown(members: ParseWindow[]): BurstWindow['ability_breakdown'] {
    const abilityDamage = new Map<number, number[]>();
    const abilityCasts = new Map<number, number[]>();
    const abilityPassive = new Map<number, boolean[]>();
    for (const member of members) {
      for (const ability of member.ability_breakdown) {
        getOrInsert(abilityDamage, ability.spell_id, () => []).push(ability.damage);
        getOrInsert(abilityCasts, ability.spell_id, () => []).push(ability.casts);
        getOrInsert(abilityPassive, ability.spell_id, () => []).push(ability.is_passive);
      }
    }
    return [...abilityDamage.entries()]
      .filter(([, list]) => list.length >= members.length * MEMBER_MAJORITY_FRAC)
      .map(([spell_id, list]) => {
        const [min = 0, max = 0] = extent(list);
        return {
          spell_id,
          avg_damage: Math.round((mean(list) ?? 0)),
          min_damage: Math.round(min),
          max_damage: Math.round(max),
          avg_casts: Math.round(mean(abilityCasts.get(spell_id) ?? []) ?? 0),
          is_passive: (abilityPassive.get(spell_id) ?? []).every(Boolean),
        };
      })
      .sort((a, b) => b.avg_damage - a.avg_damage)
      .slice(0, 6);
  }

  private clusterCommonCds(members: ParseWindow[]): string[] {
    return rollups(members.flatMap(member => member.active_cds), names => names.length, name => name)
      .sort((a, b) => b[1] - a[1])
      .filter(([, count]) => count >= members.length * MEMBER_MAJORITY_FRAC)
      .map(([name]) => name);
  }

  protected clusterParseWindows(windows: ParseWindow[], sampleCount: number): BurstWindow[] {
    const result: BurstWindow[] = [];
    for (const cluster of groupByTime(windows, CLUSTER_MERGE_S)) {
      // Reduces to one window per parse so the consensus gate and damage stats count DISTINCT parses.
      const members = this.dedupeByParse(cluster);
      if (members.length < Math.max(2, sampleCount * CLUSTER_MIN_FRAC)) continue;
      const damages = members.map(member => member.window_damage);
      const [dmgMin = 0, dmgMax = 0] = extent(damages);
      result.push({
        time_s: round(median(members.map(member => member.time_s)) ?? 0),
        dmg_avg: Math.round((mean(damages) ?? 0)),
        dmg_stddev: Math.round((deviation(damages) ?? 0)),
        dmg_min: Math.round(dmgMin),
        dmg_max: Math.round(dmgMax),
        common_cds: this.clusterCommonCds(members),
        window_length_s: round(mean(members.map(member => member.window_length_s)) ?? 0),
        ability_breakdown: this.clusterAbilityBreakdown(members),
      });
    }
    return result.sort((a, b) => a.time_s - b.time_s);
  }
}
