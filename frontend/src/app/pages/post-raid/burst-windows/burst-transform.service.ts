import { Injectable, inject } from '@angular/core';
import { WclApiService } from '../../../core/services/wcl-api';
import { DataFileApiService } from '../../../core/services/data-file-api';
import { ParseRanking } from '../../../core/models/wcl.models';
import { RulebookCooldown, RulebookDefensive } from '../../../core/models/rulebook.models';
import { BurstWindow } from '../../../core/models/analysis.models';
import { logWarn } from '../../../core/log';
import { Result, LoadError, ok, missing } from '../../../core/result';
import { toLoadError } from '../../../core/http-load-error';
import { mean, median, deviation, quantile } from 'd3-array';
import { round, groupByTime, getOrInsert } from '../../../shared/analysis/analysis-math';
import { TimedEvent, abilityIcons, normalizeAbilityId, relativeS, toParseRankings, unwrapRankings, withRelativeS } from '../../../shared/analysis/wcl-projections';
import { DataSource } from '../../../core/data-source/data-source';
import { BurstBench } from './burst-data-source';

// Re-exported so call sites and specs can import it from this service.
export { toParseRankings } from '../../../shared/analysis/wcl-projections';

const TOP_PARSE_COUNT = 10;
// Over-fetch so a private/unfetchable top parse can be backfilled by the next-best one.
const CANDIDATE_POOL_COUNT = TOP_PARSE_COUNT * 2;
const SIGNIFICANCE_PCT = 0.015;
const CLUSTER_MIN_FRAC = 0.4;
const MEMBER_MAJORITY_FRAC = 0.5;
const CLUSTER_MERGE_S = 15;

const BIN_S = 1;
const ROLL_BINS = 3;
const THRESHOLD_MULT = 1.6;
const RATE_QUANTILE = 0.66;
const MERGE_GAP_BINS = 2;

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
  /** Index of the parse this window came from, so clustering counts DISTINCT parses (stamped in getBench). */
  parse_index: number;
}

/** Bin-index span, inclusive on both ends. */
export interface BinRun {
  startBin: number;
  endBin: number;
}

/** `[atS, damage, abilityGameID]`, fight-relative. */
type DamageHit = [number, number, number];

/** A hit before/after the fight span clamps into the first/last bin. */
export function bucketDamagePerBin(hits: DamageHit[], binCount: number): number[] {
  const damagePerBin = new Array<number>(binCount).fill(0);
  for (const [atS, hitDamage] of hits) {
    const binIndex = Math.min(Math.max(Math.floor(atS / BIN_S), 0), binCount - 1);
    damagePerBin[binIndex] += hitDamage;
  }
  return damagePerBin;
}

export function forwardRollingDamage(damagePerBin: number[], rollBins: number): number[] {
  const binCount = damagePerBin.length;
  const rollingDamage = new Array<number>(binCount).fill(0);
  for (let binIndex = 0; binIndex < binCount; binIndex++) {
    let rollingSum = 0;
    for (let ahead = binIndex; ahead <= Math.min(binIndex + rollBins - 1, binCount - 1); ahead++) rollingSum += damagePerBin[ahead];
    rollingDamage[binIndex] = rollingSum;
  }
  return rollingDamage;
}

// A bin is dense at rolling damage >= densityThreshold (strict); runs bridge across up to mergeGapBins sub-threshold bins.
export function detectDenseRuns(rollingDamage: number[], densityThreshold: number, mergeGapBins: number): BinRun[] {
  const denseRuns: BinRun[] = [];
  let runStartBin = -1;
  let runEndBin = -1;
  let subThresholdBins = 0;
  for (let binIndex = 0; binIndex < rollingDamage.length; binIndex++) {
    if (rollingDamage[binIndex] >= densityThreshold) {
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

// Snaps to the bins that actually carry damage: the rolling rate can flag up to ROLL_BINS-1 damage-free bins before a burst.
export function trimRunToDamage(run: BinRun, damagePerBin: number[]): BinRun | null {
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
export function windowAbilityBreakdown(
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
export function findParseWindows(scan: ParseWindowScan): ParseWindow[] {
  const { damage, fightLenS, timings, casts, abilityNames } = scan;
  const hits = damage
    .filter(event => event.type === 'damage' && (event.amount ?? 0) + (event.absorbed ?? 0) > 0)
    .map(event => [event.atS, (event.amount ?? 0) + (event.absorbed ?? 0), event.abilityGameID] as DamageHit)
    .sort((a, b) => a[0] - b[0]);
  if (!hits.length || fightLenS <= 0) return [];
  const total = hits.reduce((sum, hit) => sum + hit[1], 0);
  if (!total) return [];

  const binCount = Math.ceil(fightLenS / BIN_S);
  if (binCount < 2) return [];
  const damagePerBin = bucketDamagePerBin(hits, binCount);
  const rollingDamage = forwardRollingDamage(damagePerBin, ROLL_BINS);

  // Threshold floors at RATE_QUANTILE so a spiky parse must beat its own typical bin, not just its mean.
  const meanRollingDamage = (total / binCount) * ROLL_BINS;
  const densityThreshold = Math.max(THRESHOLD_MULT * meanRollingDamage, quantile(rollingDamage, RATE_QUANTILE) ?? 0);

  const denseRuns = detectDenseRuns(rollingDamage, densityThreshold, MERGE_GAP_BINS);
  if (!denseRuns.length) return [];

  const castRows = casts
    .filter(event => event.type === 'cast' && event.abilityGameID)
    .map(event => [event.atS, event.abilityGameID] as CastRow);
  const nameOf = (spellId: number): string => abilityNames.get(spellId) ?? `Spell ${spellId}`;
  // A name absent here is passive (proc/auto/pet damage), not merely uncast within this window.
  const castNamesInParse = new Set(castRows.map(([, abilityId]) => nameOf(abilityId)));

  const windows: ParseWindow[] = [];
  for (const run of denseRuns) {
    const trimmed = trimRunToDamage(run, damagePerBin);
    if (!trimmed) continue;
    const windowStartS = trimmed.startBin * BIN_S;
    const windowEndS = (trimmed.endBin + 1) * BIN_S;
    // The fight-closing window counts the fight-end hit bucketDamagePerBin clamps into the last bin; interior windows stay half-open.
    const closesFight = trimmed.endBin === binCount - 1;
    const windowHits = hits.filter(hit => hit[0] >= windowStartS && (closesFight ? hit[0] <= windowEndS : hit[0] < windowEndS));
    const windowDmg = windowHits.reduce((sum, hit) => sum + hit[1], 0);
    if (!windowDmg || windowDmg / total < SIGNIFICANCE_PCT) continue;

    const ability_breakdown = windowAbilityBreakdown(windowHits, castRows, windowStartS, windowEndS, nameOf, castNamesInParse);

    // Attribute (never bound by) the cooldowns whose cast lands inside the window.
    const active_cds = timings
      .filter(timing => timing.castTimesS.some(castS => castS >= windowStartS && castS < windowEndS))
      .map(timing => timing.name);

    windows.push({
      time_s: round(windowStartS),
      window_length_s: round(windowEndS - windowStartS),
      window_damage: windowDmg,
      active_cds,
      ability_breakdown,
      parse_index: 0, // stamped per-parse in getBench
    });
  }
  return windows.sort((a, b) => a.time_s - b.time_s);
}

/** Keep each parse's biggest window (by window_damage), so a cluster counts DISTINCT parses. */
export function dedupeByParse(cluster: ParseWindow[]): ParseWindow[] {
  const byParse = new Map<number, ParseWindow>();
  for (const window of cluster) {
    const current = byParse.get(window.parse_index);
    if (!current || window.window_damage > current.window_damage) byParse.set(window.parse_index, window);
  }
  return [...byParse.values()];
}

export function clusterParseWindows(windows: ParseWindow[], sampleCount: number, mergeS = CLUSTER_MERGE_S): BurstWindow[] {
  const result: BurstWindow[] = [];
  for (const cluster of groupByTime(windows, mergeS)) {
    // Reduces to one window per parse so the consensus gate and damage stats count DISTINCT parses.
    const members = dedupeByParse(cluster);
    if (members.length < Math.max(2, sampleCount * CLUSTER_MIN_FRAC)) continue;
    const damages = members.map(member => member.window_damage);

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
    const ability_breakdown = [...abilityDamage.entries()]
      .filter(([, list]) => list.length >= members.length * MEMBER_MAJORITY_FRAC)
      .map(([spell_id, list]) => ({
        spell_id,
        avg_damage: Math.round((mean(list) ?? 0)),
        min_damage: Math.round(Math.min(...list)),
        max_damage: Math.round(Math.max(...list)),
        count: list.length,
        avg_casts: Math.round(mean(abilityCasts.get(spell_id) ?? []) ?? 0),
        is_passive: (abilityPassive.get(spell_id) ?? []).every(Boolean),
      }))
      .sort((a, b) => b.avg_damage - a.avg_damage)
      .slice(0, 6);

    const cdCounts = new Map<string, number>();
    for (const member of members) for (const name of member.active_cds) cdCounts.set(name, (cdCounts.get(name) ?? 0) + 1);
    const common_cds = [...cdCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .filter(([, count]) => count >= members.length * MEMBER_MAJORITY_FRAC)
      .map(([name]) => name);

    result.push({
      time_s: round(median(members.map(member => member.time_s)) ?? 0),
      dmg_avg: Math.round((mean(damages) ?? 0)),
      dmg_stddev: Math.round((deviation(damages) ?? 0)),
      dmg_min: Math.round(Math.min(...damages)),
      dmg_max: Math.round(Math.max(...damages)),
      common_cds,
      window_length_s: round(mean(members.map(member => member.window_length_s)) ?? 0),
      ability_breakdown,
    });
  }
  return result.sort((a, b) => a.time_s - b.time_s);
}

@Injectable({ providedIn: 'root' })
export class BurstTransformService implements DataSource<BurstBench> {
  private readonly wclApi = inject(WclApiService);
  private readonly dataFiles = inject(DataFileApiService);

  async getBench(spec: string, encounterId: number, partition?: number | null): Promise<Result<BurstBench, LoadError>> {
    const rulebook = await this.dataFiles.getRulebook(spec);
    if (!rulebook.ok) return rulebook;
    const cooldowns = rulebook.value.major_cooldowns ?? [];
    if (!cooldowns.length) return missing('Not yet ingested.');
    const defensives = rulebook.value.defensives ?? [];

    try {
      const rankings = toParseRankings(unwrapRankings(await this.wclApi.getRankings(spec, encounterId, partition)), CANDIDATE_POOL_COUNT);
      if (!rankings.length) return missing('Not yet ingested.');

      const allWindows: ParseWindow[] = [];
      let sampleCount = 0;
      let encounterName = '';
      for (const ranking of rankings) {
        const parse = await this.computeParseWindows(ranking, cooldowns);
        if (!parse) continue;
        // Stamp the parse index so clustering counts distinct parses.
        for (const window of parse.windows) window.parse_index = sampleCount;
        allWindows.push(...parse.windows);
        encounterName ||= parse.encounterName;
        sampleCount += 1;
        if (sampleCount >= TOP_PARSE_COUNT) break;
      }
      if (!sampleCount) return missing('Not yet ingested.');

      const windows = clusterParseWindows(allWindows, sampleCount);
      const cd_spell_ids = cdSpellIds(cooldowns, defensives);
      // Complete over every spell the card renders (header cooldowns and each window ability), so there's no icon fallback.
      const referencedIds = [
        ...Object.values(cd_spell_ids),
        ...windows.flatMap(window => window.ability_breakdown.map(ability => ability.spell_id)),
      ];
      return ok({
        spec,
        encounter_id: encounterId,
        encounter_name: encounterName,
        sample_count: sampleCount,
        windows,
        cd_spell_ids,
        ability_icons: abilityIcons(await this.wclApi.getAbilities(referencedIds)),
      });
    } catch (cause) {
      logWarn('BurstTransformService.getBench', cause);
      return toLoadError(cause, 'burst.bench');
    }
  }

  private async computeParseWindows(
    ranking: ParseRanking, cooldowns: RulebookCooldown[],
  ): Promise<{ windows: ParseWindow[]; encounterName: string } | null> {
    try {
      const report = await this.wclApi.getReport(ranking.report_code);
      const fight = report.fights.find(entry => entry.id === ranking.fight_id);
      const player = report.masterData?.actors?.find(actor => actor.name === ranking.player);
      if (!fight || !player) return null;

      // Names only, to attribute casts by ability name inside a parse window.
      const abilityNames = new Map<number, string>(
        (report.masterData?.abilities ?? []).map(ability => [ability.gameID, ability.name]),
      );
      const [casts, damage] = await Promise.all([
        this.wclApi.getAllEvents(ranking.report_code, fight.id, 'Casts', fight.startTime, fight.endTime, player.id),
        this.wclApi.getAllEvents(ranking.report_code, fight.id, 'DamageDone', fight.startTime, fight.endTime, player.id),
      ]);

      const castsTimed = withRelativeS(casts, fight.startTime);
      const timings = cdTimings(castsTimed, cooldowns);
      const windows = findParseWindows({
        damage: withRelativeS(damage, fight.startTime), fightLenS: relativeS(fight.endTime, fight.startTime),
        timings, casts: castsTimed, abilityNames,
      });
      return { windows, encounterName: fight.name ?? '' };
    } catch (cause) {
      logWarn(`BurstTransformService parse ${ranking.report_code}:${ranking.fight_id}`, cause);
      return null;
    }
  }
}
