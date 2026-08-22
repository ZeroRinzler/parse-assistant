import { Injectable, inject } from '@angular/core';
import { WclApiService } from '../../../core/services/wcl-api';
import { DataFileApiService } from '../../../core/services/data-file-api';
import { RulebookCooldown, RulebookDefensive } from '../../../core/models/rulebook.models';
import { BurstWindow } from '../../../core/models/analysis.models';
import { Result, missing } from '../../../core/result';
import { mean, median, deviation, extent, greatest, quantile, rollup, rollups } from 'd3-array';
import { round, groupByTime, getOrInsert } from '../../../shared/analysis/analysis-math';
import { TimedEvent, abilityIcons, normalizeAbilityId, relativeS, withRelativeS } from '../../../shared/analysis/wcl-projections';
import { BenchParse, benchFromTopParses, benchHeader } from '../../../shared/analysis/bench-pipeline';
import { DataSource } from '../../../core/data-source/data-source';
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

export function cdSpellIds(cooldowns: RulebookCooldown[], defensives: RulebookDefensive[]): Record<string, number> {
  const map: Record<string, number> = {};
  for (const cooldown of cooldowns) if (cooldown.spell_id) map[cooldown.name] = cooldown.spell_id;
  for (const defensive of defensives) if (defensive.spell_id) map[defensive.name] = defensive.spell_id;
  return map;
}

interface CdTiming { name: string; castTimesS: number[]; }

export function cdTimings(casts: TimedEvent[], cooldowns: RulebookCooldown[]): CdTiming[] {
  return cooldowns.map(cooldown => ({
    name: cooldown.name,
    castTimesS: casts
      .filter(cast => cast.type === 'cast' && cast.abilityGameID === cooldown.spell_id)
      .map(cast => cast.atS)
      .sort((a, b) => a - b),
  }));
}

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

/** A hit before/after the fight span clamps into the first/last bin. */
function bucketDamagePerBin(hits: DamageHit[], binCount: number, binS: number): number[] {
  const dmgByBin = new Map<number, number>();
  for (const [atS, hitDamage] of hits) {
    const binIndex = Math.min(Math.max(Math.floor(atS / binS), 0), binCount - 1);
    dmgByBin.set(binIndex, (dmgByBin.get(binIndex) ?? 0) + hitDamage);
  }
  return Array.from({ length: binCount }, (_, binIndex) => dmgByBin.get(binIndex) ?? 0);
}

function forwardRollingDamage(damagePerBin: number[], rollBins: number): number[] {
  return damagePerBin.map((_, binIndex) =>
    damagePerBin.slice(binIndex, binIndex + rollBins).reduce((sum, dmg) => sum + dmg, 0));
}

// A bin is dense at rolling damage >= densityThreshold (strict); runs bridge across up to mergeGapBins sub-threshold bins.
function detectDenseRuns(rollingDamage: number[], densityThreshold: number, mergeGapBins: number): BinRun[] {
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
function trimRunToDamage(run: BinRun, damagePerBin: number[]): BinRun | null {
  let windowStartBin = run.startBin;
  let windowEndBin = run.endBin;
  while (windowStartBin <= windowEndBin && damagePerBin[windowStartBin] === 0) windowStartBin++;
  while (windowEndBin >= windowStartBin && damagePerBin[windowEndBin] === 0) windowEndBin--;
  if (windowStartBin > windowEndBin) return null;
  return { startBin: windowStartBin, endBin: windowEndBin };
}

/** `[atS, abilityGameID]`, fight-relative. */
type CastRow = [number, number];

// Casts are attributed by ability NAME because a damage event's id often differs from the cast id.
function windowAbilityBreakdown(
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
    const spellId = normalizeAbilityId(abilityId);
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

export interface ParseWindowScan {
  damage: TimedEvent[];
  fightLenS: number;
  timings: CdTiming[];
  casts: TimedEvent[];
  abilityNames: Map<number, string>;
}

// Windows are the parse's damage-density bursts, not cooldown-duration spans.
export function findParseWindows(scan: ParseWindowScan, tuning: BurstDetectorTuning = DEFAULT_BURST_TUNING): ParseWindow[] {
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
  const damagePerBin = bucketDamagePerBin(hits, binCount, tuning.binS);
  const rollingDamage = forwardRollingDamage(damagePerBin, tuning.rollBins);

  // Threshold floors at the rateQuantile bin so a spiky parse must beat its own typical bin, not just its mean.
  const meanRollingDamage = (total / binCount) * tuning.rollBins;
  const densityThreshold = Math.max(
    tuning.thresholdMult * meanRollingDamage, quantile(rollingDamage, tuning.rateQuantile) ?? 0);

  const denseRuns = detectDenseRuns(rollingDamage, densityThreshold, tuning.mergeGapBins);
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
    const window = windowFromRun(run, context);
    if (window) windows.push(window);
  }
  return windows.sort((a, b) => a.time_s - b.time_s);
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

function windowFromRun(run: BinRun, context: RunWindowContext): ParseWindow | null {
  const { hits, total, binCount, damagePerBin, timings, castRows, nameOf, castNamesInParse, tuning } = context;
  const trimmed = trimRunToDamage(run, damagePerBin);
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
    ability_breakdown: windowAbilityBreakdown(windowHits, castRows, windowStartS, windowEndS, nameOf, castNamesInParse),
    parse_index: 0, // stamped once the parse is accepted
  };
}

/** Keep each parse's biggest window (by window_damage), so a cluster counts DISTINCT parses. */
function dedupeByParse(cluster: ParseWindow[]): ParseWindow[] {
  const biggest = rollup(cluster, windows => greatest(windows, window => window.window_damage), window => window.parse_index);
  return [...biggest.values()].filter(window => window != null);
}

/** Keeps an ability only when a majority of the cluster's parses used it, so a single parse's pet cannot invent a row. */
function clusterAbilityBreakdown(members: ParseWindow[]): BurstWindow['ability_breakdown'] {
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

function clusterCommonCds(members: ParseWindow[]): string[] {
  return rollups(members.flatMap(member => member.active_cds), names => names.length, name => name)
    .sort((a, b) => b[1] - a[1])
    .filter(([, count]) => count >= members.length * MEMBER_MAJORITY_FRAC)
    .map(([name]) => name);
}

export function clusterParseWindows(windows: ParseWindow[], sampleCount: number): BurstWindow[] {
  const result: BurstWindow[] = [];
  for (const cluster of groupByTime(windows, CLUSTER_MERGE_S)) {
    // Reduces to one window per parse so the consensus gate and damage stats count DISTINCT parses.
    const members = dedupeByParse(cluster);
    if (members.length < Math.max(2, sampleCount * CLUSTER_MIN_FRAC)) continue;
    const damages = members.map(member => member.window_damage);
    const [dmgMin = 0, dmgMax = 0] = extent(damages);
    result.push({
      time_s: round(median(members.map(member => member.time_s)) ?? 0),
      dmg_avg: Math.round((mean(damages) ?? 0)),
      dmg_stddev: Math.round((deviation(damages) ?? 0)),
      dmg_min: Math.round(dmgMin),
      dmg_max: Math.round(dmgMax),
      common_cds: clusterCommonCds(members),
      window_length_s: round(mean(members.map(member => member.window_length_s)) ?? 0),
      ability_breakdown: clusterAbilityBreakdown(members),
    });
  }
  return result.sort((a, b) => a.time_s - b.time_s);
}

@Injectable({ providedIn: 'root' })
export class BurstTransformService implements DataSource<BurstBench> {
  private readonly wclApi = inject(WclApiService);
  private readonly dataFiles = inject(DataFileApiService);

  async getBench(spec: string, encounterId: number, partition?: number | null): Promise<Result<BurstBench>> {
    const rulebook = await this.dataFiles.getRulebook(spec);
    if (!rulebook.ok) return rulebook;
    const cooldowns = rulebook.value.major_cooldowns;
    if (!cooldowns.length) return missing('Not yet ingested.');
    const defensives = rulebook.value.defensives;

    return benchFromTopParses(this.wclApi, { spec, encounterId, partition }, {
      logSource: 'BurstTransformService',
      errorId: 'burst.bench',
      noRankingsMessage: 'Not yet ingested.',
      parse: parse => this.parseWindows(parse, cooldowns),
      bench: async ({ encounterName, parses }) => {
        const allWindows = parses.flatMap(
          (windows, parseIndex) => windows.map(window => ({ ...window, parse_index: parseIndex })));
        const windows = clusterParseWindows(allWindows, parses.length);
        const cd_spell_ids = cdSpellIds(cooldowns, defensives);
        // Complete over every spell the card renders (header cooldowns and each window ability), so there's no icon fallback.
        const referencedIds = [
          ...Object.values(cd_spell_ids),
          ...windows.flatMap(window => window.ability_breakdown.map(ability => ability.spell_id)),
        ];
        return {
          ...benchHeader(spec, encounterId, encounterName, parses.length),
          windows,
          cd_spell_ids,
          ability_icons: abilityIcons(await this.wclApi.getAbilities(referencedIds)),
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

    const castsTimed = withRelativeS(casts, fight.startTime);
    return findParseWindows({
      damage: withRelativeS(damage, fight.startTime), fightLenS: relativeS(fight.endTime, fight.startTime),
      timings: cdTimings(castsTimed, cooldowns), casts: castsTimed, abilityNames,
    });
  }
}
