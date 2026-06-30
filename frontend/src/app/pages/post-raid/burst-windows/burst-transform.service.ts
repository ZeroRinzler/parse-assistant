/**
 * Live `DataSource<BurstBench>`: computes the burst bench live in the browser (no
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
import { round, groupByTime } from '../../../shared/analysis/analysis-math';
import { DataSource } from '../../../core/data-source/data-source';
import { BurstBench } from './burst-data-source';

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

/** A `[startBin, endBin]` bin-index span (inclusive on both ends). */
export interface BinRun {
  startBin: number;
  endBin: number;
}

/** One damage hit as `[timestamp, damage, abilityGameID]`, sorted by timestamp. */
type DamageHit = [number, number, number];

/**
 * Bucket damage hits into `binCount` fixed `BIN_MS` bins spanning the fight, indexed
 * from `fightStartMs`. A hit before/after the span clamps into the first/last bin.
 */
export function bucketDamagePerBin(hits: DamageHit[], fightStartMs: number, binCount: number): number[] {
  const damagePerBin = new Array<number>(binCount).fill(0);
  for (const [timestamp, hitDamage] of hits) {
    const binIndex = Math.min(Math.max(Math.floor((timestamp - fightStartMs) / BIN_MS), 0), binCount - 1);
    damagePerBin[binIndex] += hitDamage;
  }
  return damagePerBin;
}

/** Each bin's forward rolling damage: itself + the next `rollBins - 1` bins. */
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

/**
 * Contiguous runs of dense bins. A bin is dense when its rolling damage clears
 * `densityThreshold` (strict `>=`). A run opens at the first dense bin and extends
 * while bins stay dense or fall short by at most `mergeGapBins` sub-threshold bins
 * (which bridge two dense stretches); a longer gap finalizes the run at its last
 * dense bin.
 */
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

/**
 * Snap a dense run to the bins that actually carry damage: the forward rolling rate
 * can flag up to ROLL_BINS-1 damage-free bins before a burst, which would otherwise
 * start the window early. Returns null when the run carries no damage at all.
 */
export function trimRunToDamage(run: BinRun, damagePerBin: number[]): BinRun | null {
  let windowStartBin = run.startBin;
  let windowEndBin = run.endBin;
  while (windowStartBin <= windowEndBin && damagePerBin[windowStartBin] === 0) windowStartBin++;
  while (windowEndBin >= windowStartBin && damagePerBin[windowEndBin] === 0) windowEndBin--;
  if (windowStartBin > windowEndBin) return null;
  return { startBin: windowStartBin, endBin: windowEndBin };
}

/** A `[timestamp, abilityGameID]` cast pair. */
type CastRow = [number, number];

/**
 * Top-6 ability breakdown for one window: damage by ability id, the cast count for
 * each (attributed by ability NAME, since a damage event's id often differs from the
 * cast id), and whether the ability is passive (never cast anywhere in the parse).
 * The window span is the half-open `[startMs, endMs)`.
 */
export function windowAbilityBreakdown(
  windowHits: DamageHit[],
  castRows: CastRow[],
  startMs: number,
  endMs: number,
  nameOf: (spellId: number) => string,
  castNamesInParse: Set<string>,
): ParseWindow['ability_breakdown'] {
  const byAbility = new Map<number, number>();
  for (const [, dmg, abilityId] of windowHits) if (abilityId) byAbility.set(abilityId, (byAbility.get(abilityId) ?? 0) + dmg);

  const castsByName = new Map<string, number>();
  for (const [timestamp, abilityId] of castRows) {
    if (timestamp >= startMs && timestamp < endMs) castsByName.set(nameOf(abilityId), (castsByName.get(nameOf(abilityId)) ?? 0) + 1);
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

/** The positional inputs to `findParseWindows`, as a named parameter object. */
export interface ParseWindowScan {
  damage: WclEvent[];
  fightStartMs: number;
  fightEndMs: number;
  timings: CdTiming[];
  casts: WclEvent[];
  abilityNames: Map<number, string>;
  minPct?: number;
}

/**
 * One parse's burst windows, measured as damage-density bursts: bucket DamageDone
 * into 1s bins, take a 3s rolling rate, and mark the bins whose rate runs well above
 * the parse mean as "dense". Contiguous dense bins (bridging up to MERGE_GAP_BINS
 * sub-threshold bins) form a window. Keep windows above the significance threshold,
 * attribute the cooldowns cast inside each, and break damage + casts down by ability
 * (top 6). Windows come from where the damage lands, not from cooldown durations.
 */
export function findParseWindows(scan: ParseWindowScan): ParseWindow[] {
  const { damage, fightStartMs, fightEndMs, timings, casts, abilityNames } = scan;
  const minPct = scan.minPct ?? SIGNIFICANCE_PCT;
  const fightLenMs = fightEndMs - fightStartMs;
  const hits = damage
    .filter(event => event.type === 'damage' && (event.amount ?? 0) + (event.absorbed ?? 0) > 0)
    .map(event => [event.timestamp, (event.amount ?? 0) + (event.absorbed ?? 0), event.abilityGameID] as DamageHit)
    .sort((a, b) => a[0] - b[0]);
  if (!hits.length || fightLenMs <= 0) return [];
  const total = hits.reduce((sum, hit) => sum + hit[1], 0);
  if (!total) return [];

  const binCount = Math.ceil(fightLenMs / BIN_MS);
  if (binCount < 2) return [];
  const damagePerBin = bucketDamagePerBin(hits, fightStartMs, binCount);
  const rollingDamage = forwardRollingDamage(damagePerBin, ROLL_BINS);

  // A bin is dense when its rolling damage clears THRESHOLD_MULT x the mean rolling
  // damage, floored at the RATE_QUANTILE of the rolling-damage distribution (so a spiky
  // parse still has to beat its own typical bin, not just its mean).
  const meanRollingDamage = (total / binCount) * ROLL_BINS;
  const densityThreshold = Math.max(THRESHOLD_MULT * meanRollingDamage, quantile(rollingDamage, RATE_QUANTILE) ?? 0);

  const denseRuns = detectDenseRuns(rollingDamage, densityThreshold, MERGE_GAP_BINS);
  if (!denseRuns.length) return [];

  const castRows = casts
    .filter(event => event.type === 'cast' && event.abilityGameID)
    .map(event => [event.timestamp, event.abilityGameID] as CastRow);
  const nameOf = (spellId: number): string => abilityNames.get(spellId) ?? `Spell ${spellId}`;
  // Parse-global set of every ability name that was ever cast. An ability whose
  // name never appears here is passive (proc/auto/pet damage), as opposed to an
  // active ability that merely had no cast inside a given window.
  const castNamesInParse = new Set(castRows.map(([, abilityId]) => nameOf(abilityId)));

  const windows: ParseWindow[] = [];
  for (const run of denseRuns) {
    const trimmed = trimRunToDamage(run, damagePerBin);
    if (!trimmed) continue;
    const windowStartS = trimmed.startBin * BIN_S;
    const windowEndS = (trimmed.endBin + 1) * BIN_S;
    const startMs = fightStartMs + windowStartS * 1000;
    const endMs = fightStartMs + windowEndS * 1000;
    // Half-open window end (< endMs) to match findPlayerBurstWindows, so a hit/cast
    // exactly on the boundary is attributed identically on the bench and player sides.
    const windowHits = hits.filter(hit => hit[0] >= startMs && hit[0] < endMs);
    const windowDmg = windowHits.reduce((sum, hit) => sum + hit[1], 0);
    if (!windowDmg || windowDmg / total < minPct) continue;

    const ability_breakdown = windowAbilityBreakdown(windowHits, castRows, startMs, endMs, nameOf, castNamesInParse);

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
export class BurstTransformService implements DataSource<BurstBench> {
  private readonly wclApi = inject(WclApiService);
  private readonly dataFiles = inject(DataFileApiService);

  async getBench(spec: string, encounterId: number): Promise<BurstBench | null> {
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
      const windows = findParseWindows({
        damage, fightStartMs: fight.startTime, fightEndMs: fight.endTime, timings, casts, abilityNames,
      });
      return { windows, encounterName: fight.name ?? '' };
    } catch (err) {
      logWarn(`BurstTransformService parse ${ranking.report_code}:${ranking.fight_id}`, err);
      return null;
    }
  }
}
