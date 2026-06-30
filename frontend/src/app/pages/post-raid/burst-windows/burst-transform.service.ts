/**
 * Dev-flag `BurstDataSource`: computes the burst bench live in the browser (no
 * ingestion). Self-contained per the slice rule - it imports ONLY the two API
 * services + models + `logWarn`, and reimplements its own burst math below (it does
 * NOT reference the ingest analysis). Bound by `environment.useLiveTransform`.
 *
 * It fetches the encounter's top parses, refetches each parse's Casts + DamageDone,
 * finds each parse's measured damage-density bursts (the stretches where the player's
 * DamageDone rate runs well above its fight-average), and clusters them across parses.
 * Windows are derived from where the damage actually lands, not from cooldown-cast x
 * rulebook-`duration` spans; cooldowns are only attributed onto a window after the
 * fact. Bloodlust timing is irrelevant here, so Buffs are skipped.
 */
import { Injectable, inject } from '@angular/core';
import { WclApiService } from '../../../core/services/wcl-api';
import { DataFileApiService } from '../../../core/services/data-file-api';
import { WclEvent, ParseRanking, WclRawRanking } from '../../../core/models/wcl.models';
import { RulebookCooldown, RulebookDefensive } from '../../../core/models/rulebook.models';
import { BurstWindow } from '../../../core/models/analysis.models';
import { logWarn } from '../../../core/log';
import { mean, median, deviation, quantile } from 'd3-array';
import { BurstBench, BurstDataSource } from './burst-data-source';

/** How many top parses to sample (matches the ingest bench). */
const TOP_PARSE_COUNT = 10;
// Over-fetch so a private/unfetchable top parse can be backfilled by the
// next-best one; the break in the loop caps actual fetches at TOP_PARSE_COUNT.
const CANDIDATE_POOL_COUNT = TOP_PARSE_COUNT * 2;
/** A window must carry at least this share of fight damage to count. */
const SIGNIFICANCE_PCT = 0.03;
/** Min cluster size as a fraction of samples to surface a window (majority of parses). */
const CLUSTER_MIN_FRAC = 0.5;
/** "At least half the member parses" - ability/cd inclusion in a cluster. */
const MEMBER_MAJORITY_FRAC = 0.5;
/** Windows within this many seconds cluster together. */
const CLUSTER_MERGE_S = 15;

/* ---- damage-density window detection (per parse) ---- */
/** Sub-window bin width: damage is bucketed into 1s bins. */
const BIN_MS = 1000;
const BIN_S = BIN_MS / 1000;
/** Rolling-rate window: each bin's rate sums itself + the next ROLL_BINS-1 bins. */
const ROLL_BINS = 3;
/** A bin is "dense" when its rolling rate is at least this multiple of the mean rolling rate. */
const THRESHOLD_MULT = 1.6;
/** Floor the density threshold at this quantile of the rolling-rate distribution. */
const RATE_QUANTILE = 0.66;
/** Bridge two dense runs separated by at most this many sub-threshold bins. */
const MERGE_GAP_BINS = 2;

/* ----------------------------- pure helpers (own math) ----------------------------- */

// WCL anonymizes a privacy-protected parse's player name to "Character <id>-<id>",
// which can never match a report actor (real names are letters only), so the parse
// is unfetchable. Drop these before mapping.
const ANONYMIZED_NAME = /^Character \d+-\d+$/;

/** Map raw WCL rankings to the top `count` fetchable parses (report + fight + player). */
export function toParseRankings(raw: WclRawRanking[], count: number): ParseRanking[] {
  return raw
    .filter(ranking => ranking.report?.code && !ANONYMIZED_NAME.test(ranking.name ?? ''))
    .slice(0, count)
    .map(ranking => ({
      player: ranking.name ?? '',
      report_code: ranking.report?.code ?? '',
      fight_id: ranking.report?.fightID ?? 0,
    }));
}


/** Round to `decimals` places (default 1). d3-array has no rounding helper. */
function round(value: number, decimals = 1): number {
  return Math.round(value * 10 ** decimals) / 10 ** decimals;
}

/** Group windows whose time is within `mergeS` of the running cluster median. */
function groupByTime<T extends { time_s: number }>(windows: T[], mergeS: number): T[][] {
  const sorted = [...windows].sort((a, b) => a.time_s - b.time_s);
  const clusters: T[][] = [];
  let openTimes: number[] = [];
  for (const window of sorted) {
    if (clusters.length && Math.abs(window.time_s - (median(openTimes) ?? 0)) <= mergeS) {
      clusters[clusters.length - 1].push(window);
      openTimes.push(window.time_s);
    } else {
      clusters.push([window]);
      openTimes = [window.time_s];
    }
  }
  return clusters;
}

/** Cooldown name -> spell id, for the burst window header icons. */
export function cdSpellIds(cooldowns: RulebookCooldown[], defensives: RulebookDefensive[]): Record<string, number> {
  const map: Record<string, number> = {};
  for (const cooldown of cooldowns) if (cooldown.spell_id) map[cooldown.name] = cooldown.spell_id;
  for (const defensive of defensives) if (defensive.spell_id) map[defensive.name] = defensive.spell_id;
  return map;
}

interface CdTiming { name: string; castTimesS: number[]; }

/** Per-cooldown cast times (fight-relative seconds), for post-hoc window attribution. */
export function cdTimings(casts: WclEvent[], cooldowns: RulebookCooldown[], fightStartMs: number): CdTiming[] {
  return cooldowns.map(cooldown => ({
    name: cooldown.name,
    castTimesS: casts
      .filter(cast => cast.type === 'cast' && cast.abilityGameID === cooldown.spell_id)
      .map(cast => (cast.timestamp - fightStartMs) / 1000)
      .sort((a, b) => a - b),
  }));
}

/** One parse's burst window before cross-parse clustering. */
export interface ParseWindow {
  time_s: number;
  window_length_s: number;
  window_damage: number;
  active_cds: string[];
  ability_breakdown: { spell_id: number; damage: number; casts: number; is_passive: boolean }[];
}

/**
 * One parse's burst windows, measured as damage-density bursts: bucket DamageDone
 * into 1s bins, take a 3s rolling rate, and mark the bins whose rate runs well above
 * the parse mean as "dense". Contiguous dense bins (bridging up to MERGE_GAP_BINS
 * sub-threshold bins) form a window. Keep windows above the significance threshold,
 * attribute the cooldowns cast inside each, and break damage + casts down by ability
 * (top 6). Windows come from where the damage lands, not from cooldown durations.
 */
export function findParseWindows(
  damage: WclEvent[], fightStartMs: number, fightEndMs: number, timings: CdTiming[],
  casts: WclEvent[], abilityNames: Map<number, string>, minPct = SIGNIFICANCE_PCT,
): ParseWindow[] {
  const fightLenMs = fightEndMs - fightStartMs;
  const hits = damage
    .filter(event => event.type === 'damage' && (event.amount ?? 0) + (event.absorbed ?? 0) > 0)
    .map(event => [event.timestamp, (event.amount ?? 0) + (event.absorbed ?? 0), event.abilityGameID] as [number, number, number])
    .sort((a, b) => a[0] - b[0]);
  if (!hits.length || fightLenMs <= 0) return [];
  const total = hits.reduce((sum, hit) => sum + hit[1], 0);
  if (!total) return [];

  // Bucket damage into fixed 1s bins spanning the fight.
  const binCount = Math.ceil(fightLenMs / BIN_MS);
  if (binCount < 2) return [];
  const damagePerBin = new Array<number>(binCount).fill(0);
  for (const [timestamp, hitDamage] of hits) {
    const binIndex = Math.min(Math.max(Math.floor((timestamp - fightStartMs) / BIN_MS), 0), binCount - 1);
    damagePerBin[binIndex] += hitDamage;
  }

  // Each bin's forward rolling damage: itself + the next ROLL_BINS-1 bins.
  const rollingDamage = new Array<number>(binCount).fill(0);
  for (let binIndex = 0; binIndex < binCount; binIndex++) {
    let rollingSum = 0;
    for (let ahead = binIndex; ahead <= Math.min(binIndex + ROLL_BINS - 1, binCount - 1); ahead++) rollingSum += damagePerBin[ahead];
    rollingDamage[binIndex] = rollingSum;
  }

  // A bin is dense when its rolling damage clears THRESHOLD_MULT x the mean rolling
  // damage, floored at the RATE_QUANTILE of the rolling-damage distribution (so a spiky
  // parse still has to beat its own typical bin, not just its mean).
  const meanRollingDamage = (total / binCount) * ROLL_BINS;
  const densityThreshold = Math.max(THRESHOLD_MULT * meanRollingDamage, quantile(rollingDamage, RATE_QUANTILE) ?? 0);

  // Open a dense run at the first dense bin and extend it while bins stay dense or fall
  // short by at most MERGE_GAP_BINS sub-threshold bins (which bridge two dense stretches);
  // a longer gap finalizes the run at its last dense bin.
  const denseRuns: { startBin: number; endBin: number }[] = [];
  let runStartBin = -1;
  let runEndBin = -1;
  let subThresholdBins = 0;
  for (let binIndex = 0; binIndex < binCount; binIndex++) {
    if (rollingDamage[binIndex] >= densityThreshold) {
      if (runStartBin < 0) runStartBin = binIndex;
      runEndBin = binIndex;
      subThresholdBins = 0;
    } else if (runStartBin >= 0) {
      subThresholdBins += 1;
      if (subThresholdBins > MERGE_GAP_BINS) {
        denseRuns.push({ startBin: runStartBin, endBin: runEndBin });
        runStartBin = -1;
      }
    }
  }
  if (runStartBin >= 0) denseRuns.push({ startBin: runStartBin, endBin: runEndBin });
  if (!denseRuns.length) return [];

  const castRows = casts
    .filter(event => event.type === 'cast' && event.abilityGameID)
    .map(event => [event.timestamp, event.abilityGameID] as [number, number]);
  const nameOf = (spellId: number): string => abilityNames.get(spellId) ?? `Spell ${spellId}`;
  // Parse-global set of every ability name that was ever cast. An ability whose
  // name never appears here is passive (proc/auto/pet damage), as opposed to an
  // active ability that merely had no cast inside a given window.
  const castNamesInParse = new Set(castRows.map(([, abilityId]) => nameOf(abilityId)));

  const windows: ParseWindow[] = [];
  for (const run of denseRuns) {
    // Snap the window to the bins that actually carry damage: the forward rolling rate
    // can flag up to ROLL_BINS-1 damage-free bins before a burst, which would otherwise
    // start the window early.
    let windowStartBin = run.startBin;
    let windowEndBin = run.endBin;
    while (windowStartBin <= windowEndBin && damagePerBin[windowStartBin] === 0) windowStartBin++;
    while (windowEndBin >= windowStartBin && damagePerBin[windowEndBin] === 0) windowEndBin--;
    if (windowStartBin > windowEndBin) continue;
    const windowStartS = windowStartBin * BIN_S;
    const windowEndS = (windowEndBin + 1) * BIN_S;
    const startMs = fightStartMs + windowStartS * 1000;
    const endMs = fightStartMs + windowEndS * 1000;
    // Half-open window end (< endMs) to match findPlayerBurstWindows, so a hit/cast
    // exactly on the boundary is attributed identically on the bench and player sides.
    const windowHits = hits.filter(hit => hit[0] >= startMs && hit[0] < endMs);
    const windowDmg = windowHits.reduce((sum, hit) => sum + hit[1], 0);
    if (!windowDmg || windowDmg / total < minPct) continue;

    const byAbility = new Map<number, number>();
    for (const [, dmg, abilityId] of windowHits) if (abilityId) byAbility.set(abilityId, (byAbility.get(abilityId) ?? 0) + dmg);

    const castsByName = new Map<string, number>();
    for (const [timestamp, abilityId] of castRows) {
      if (timestamp >= startMs && timestamp < endMs) castsByName.set(nameOf(abilityId), (castsByName.get(nameOf(abilityId)) ?? 0) + 1);
    }

    const ability_breakdown = [...byAbility.entries()]
      .sort((a, b) => b[1] - a[1]).slice(0, 6)
      .map(([spell_id, dmg]) => ({
        spell_id,
        damage: dmg,
        casts: castsByName.get(nameOf(spell_id)) ?? 0,
        is_passive: !castNamesInParse.has(nameOf(spell_id)),
      }));

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
    });
  }
  return windows.sort((a, b) => a.time_s - b.time_s);
}

/**
 * Cluster per-parse damage-density windows across parses into the bench
 * `BurstWindow[]`: group windows whose start is within CLUSTER_MERGE_S, keep only a
 * burst a majority of parses share, and emit absolute-damage + mean-length stats.
 */
export function clusterParseWindows(windows: ParseWindow[], sampleCount: number, mergeS = CLUSTER_MERGE_S): BurstWindow[] {
  const result: BurstWindow[] = [];
  for (const cluster of groupByTime(windows, mergeS)) {
    if (cluster.length < Math.max(2, sampleCount * CLUSTER_MIN_FRAC)) continue;
    const damages = cluster.map(member => member.window_damage);

    const abilityDamage = new Map<number, number[]>();
    const abilityCasts = new Map<number, number[]>();
    const abilityPassive = new Map<number, boolean[]>();
    for (const member of cluster) {
      for (const ability of member.ability_breakdown) {
        if (!abilityDamage.has(ability.spell_id)) {
          abilityDamage.set(ability.spell_id, []);
          abilityCasts.set(ability.spell_id, []);
          abilityPassive.set(ability.spell_id, []);
        }
        abilityDamage.get(ability.spell_id)!.push(ability.damage);
        abilityCasts.get(ability.spell_id)!.push(ability.casts);
        abilityPassive.get(ability.spell_id)!.push(ability.is_passive);
      }
    }
    const ability_breakdown = [...abilityDamage.entries()]
      .filter(([, list]) => list.length >= cluster.length * MEMBER_MAJORITY_FRAC)
      .map(([spell_id, list]) => ({
        spell_id,
        avg_damage: Math.round((mean(list) ?? 0)),
        min_damage: Math.round(Math.min(...list)),
        max_damage: Math.round(Math.max(...list)),
        count: list.length,
        avg_casts: Math.round(mean(abilityCasts.get(spell_id) ?? []) ?? 0),
        // Passive only when no member parse ever cast it (every observation passive).
        is_passive: (abilityPassive.get(spell_id) ?? []).every(Boolean),
      }))
      .sort((a, b) => b.avg_damage - a.avg_damage)
      .slice(0, 6);

    const cdCounts = new Map<string, number>();
    for (const member of cluster) for (const name of member.active_cds) cdCounts.set(name, (cdCounts.get(name) ?? 0) + 1);
    const common_cds = [...cdCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .filter(([, count]) => count >= cluster.length * MEMBER_MAJORITY_FRAC)
      .map(([name]) => name);

    result.push({
      time_s: round(median(cluster.map(member => member.time_s)) ?? 0),
      dmg_avg: Math.round((mean(damages) ?? 0)),
      dmg_stddev: Math.round((deviation(damages) ?? 0)),
      dmg_min: Math.round(Math.min(...damages)),
      dmg_max: Math.round(Math.max(...damages)),
      common_cds,
      window_length_s: round(mean(cluster.map(member => member.window_length_s)) ?? 0),
      ability_breakdown,
    });
  }
  return result.sort((a, b) => a.time_s - b.time_s);
}

/* ----------------------------- service shell ----------------------------- */

@Injectable({ providedIn: 'root' })
export class BurstTransformService implements BurstDataSource {
  private readonly wclApi = inject(WclApiService);
  private readonly dataFiles = inject(DataFileApiService);

  async getBurstBench(spec: string, encounterId: number): Promise<BurstBench | null> {
    const rulebook = await this.dataFiles.getRulebook(spec);
    const cooldowns = rulebook?.major_cooldowns ?? [];
    if (!cooldowns.length) return null;
    const defensives = rulebook?.defensives ?? [];

    const rankings = toParseRankings(await this.wclApi.getRankings(spec, encounterId), CANDIDATE_POOL_COUNT);
    if (!rankings.length) return null;

    const allWindows: ParseWindow[] = [];
    let sampleCount = 0;
    let encounterName = '';
    for (const ranking of rankings) {
      const parse = await this.computeParseWindows(ranking, cooldowns);
      if (!parse) continue;
      allWindows.push(...parse.windows);
      encounterName ||= parse.encounterName;
      sampleCount += 1;
      if (sampleCount >= TOP_PARSE_COUNT) break;
    }
    if (!sampleCount) return null;

    const windows = clusterParseWindows(allWindows, sampleCount);
    const cd_spell_ids = cdSpellIds(cooldowns, defensives);
    // Resolve a real icon for every spell the card renders - header cooldowns and
    // each window ability - by id, so the map is complete (no fallback).
    const referencedIds = [
      ...Object.values(cd_spell_ids),
      ...windows.flatMap(window => window.ability_breakdown.map(ability => ability.spell_id)),
    ];
    return {
      spec,
      encounter_id: encounterId,
      encounter_name: encounterName,
      sample_count: sampleCount,
      windows,
      cd_spell_ids,
      ability_icons: await this.wclApi.getAbilities(referencedIds),
    };
  }

  /** One parse's burst windows via the colocated pure fns; null if it can't be fetched. */
  private async computeParseWindows(
    ranking: ParseRanking, cooldowns: RulebookCooldown[],
  ): Promise<{ windows: ParseWindow[]; encounterName: string } | null> {
    try {
      const report = await this.wclApi.getReport(ranking.report_code);
      const fight = report.fights.find(entry => entry.id === ranking.fight_id);
      const player = report.masterData?.actors?.find(actor => actor.name === ranking.player);
      if (!fight || !player) return null;

      // Names only - used to attribute casts by ability name inside a parse window.
      const abilityNames = new Map<number, string>(
        (report.masterData?.abilities ?? []).map(ability => [ability.gameID, ability.name]),
      );
      const [casts, damage] = await Promise.all([
        this.wclApi.getAllEvents(ranking.report_code, fight.id, 'Casts', fight.startTime, fight.endTime, player.id),
        this.wclApi.getAllEvents(ranking.report_code, fight.id, 'DamageDone', fight.startTime, fight.endTime, player.id),
      ]);

      const timings = cdTimings(casts, cooldowns, fight.startTime);
      const windows = findParseWindows(damage, fight.startTime, fight.endTime, timings, casts, abilityNames);
      return { windows, encounterName: fight.name ?? '' };
    } catch (err) {
      logWarn(`BurstTransformService parse ${ranking.report_code}:${ranking.fight_id}`, err);
      return null;
    }
  }
}
