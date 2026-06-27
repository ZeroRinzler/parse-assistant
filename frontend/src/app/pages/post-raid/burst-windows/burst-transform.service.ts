/**
 * Dev-flag `BurstDataSource`: computes the burst bench live in the browser (no
 * ingestion). Self-contained per the slice rule - it imports ONLY the two API
 * services + models + `logWarn`, and reimplements its own burst math below (it does
 * NOT reference the ingest analysis). Bound by `environment.useLiveTransform`.
 *
 * It fetches the encounter's top parses, refetches each parse's Casts + DamageDone,
 * builds per-parse burst windows, and clusters them across parses. Bloodlust timing
 * is irrelevant here (windows key off cooldown cast times only), so Buffs are skipped.
 */
import { Injectable, inject } from '@angular/core';
import { WclApiService } from '../../../core/services/wcl-api';
import { DataFileApiService } from '../../../core/services/data-file-api';
import { WclEvent, ParseRanking, WclRawRanking } from '../../../core/models/wcl.models';
import { RulebookCooldown, RulebookDefensive } from '../../../core/models/rulebook.models';
import { BurstWindow } from '../../../core/models/analysis.models';
import { logWarn } from '../../../core/log';
import { mean, median, deviation } from 'd3-array';
import { BurstBench, BurstDataSource } from './burst-data-source';

/** How many top parses to sample (matches the ingest bench). */
const TOP_PARSE_COUNT = 10;
/** A window must carry at least this share of fight damage to count. */
const SIGNIFICANCE_PCT = 0.03;
/** Min cluster size as a fraction of samples to surface a window. */
const CLUSTER_MIN_FRAC = 0.35;
/** "More than half the member parses" - ability/cd inclusion in a cluster. */
const MEMBER_MAJORITY_FRAC = 0.5;
/** Windows within this many seconds cluster together. */
const CLUSTER_MERGE_S = 15;

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

interface CdTiming { name: string; duration: number; castTimesS: number[]; }

/** Per-cooldown cast times (fight-relative seconds) + its window duration. */
export function cdTimings(casts: WclEvent[], cooldowns: RulebookCooldown[], fightStartMs: number): CdTiming[] {
  return cooldowns.map(cooldown => ({
    name: cooldown.name,
    duration: cooldown.duration ?? 0,
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
  ability_breakdown: { spell_id: number; damage: number; casts: number }[];
}

/**
 * One parse's burst windows: build candidate windows from cooldown cast times x
 * durations, merge near-adjacent ones (<=3s gap), keep those above the significance
 * threshold, and break damage + casts down by ability (top 6).
 */
export function findParseWindows(
  damage: WclEvent[], fightStartMs: number, timings: CdTiming[],
  casts: WclEvent[], abilityNames: Map<number, string>, minPct = SIGNIFICANCE_PCT,
): ParseWindow[] {
  const hits = damage
    .filter(event => event.type === 'damage' && (event.amount ?? 0) + (event.absorbed ?? 0) > 0)
    .map(event => [event.timestamp, (event.amount ?? 0) + (event.absorbed ?? 0), event.abilityGameID] as [number, number, number])
    .sort((a, b) => a[0] - b[0]);
  if (!hits.length) return [];
  const total = hits.reduce((sum, hit) => sum + hit[1], 0);
  if (!total) return [];

  const castRows = casts
    .filter(event => event.type === 'cast' && event.abilityGameID)
    .map(event => [event.timestamp, event.abilityGameID] as [number, number]);

  const raw: { startS: number; endS: number; cdNames: string[] }[] = [];
  for (const timing of timings) {
    if (timing.duration <= 0) continue;
    for (const castS of timing.castTimesS) raw.push({ startS: castS, endS: castS + timing.duration, cdNames: [timing.name] });
  }
  if (!raw.length) return [];
  raw.sort((a, b) => a.startS - b.startS);

  const merged: { startS: number; endS: number; cdNames: string[] }[] = [{ ...raw[0], cdNames: [...raw[0].cdNames] }];
  for (let i = 1; i < raw.length; i++) {
    const prev = merged[merged.length - 1];
    const current = raw[i];
    if (current.startS <= prev.endS + 3) {
      prev.endS = Math.max(prev.endS, current.endS);
      for (const name of current.cdNames) if (!prev.cdNames.includes(name)) prev.cdNames.push(name);
    } else {
      merged.push({ ...current, cdNames: [...current.cdNames] });
    }
  }

  const nameOf = (spellId: number): string => abilityNames.get(spellId) ?? `Spell ${spellId}`;
  const windows: ParseWindow[] = [];
  for (const window of merged) {
    const startMs = fightStartMs + window.startS * 1000;
    const endMs = fightStartMs + window.endS * 1000;
    const windowHits = hits.filter(hit => hit[0] >= startMs && hit[0] <= endMs);
    const windowDmg = windowHits.reduce((sum, hit) => sum + hit[1], 0);
    if (!windowDmg || windowDmg / total < minPct) continue;

    const byAbility = new Map<number, number>();
    for (const [, dmg, abilityId] of windowHits) if (abilityId) byAbility.set(abilityId, (byAbility.get(abilityId) ?? 0) + dmg);

    const castsByName = new Map<string, number>();
    for (const [timestamp, abilityId] of castRows) {
      if (timestamp >= startMs && timestamp <= endMs) castsByName.set(nameOf(abilityId), (castsByName.get(nameOf(abilityId)) ?? 0) + 1);
    }

    const ability_breakdown = [...byAbility.entries()]
      .sort((a, b) => b[1] - a[1]).slice(0, 6)
      .map(([spell_id, dmg]) => ({ spell_id, damage: dmg, casts: castsByName.get(nameOf(spell_id)) ?? 0 }));

    windows.push({
      time_s: round(window.startS),
      window_length_s: round(window.endS - window.startS),
      window_damage: windowDmg,
      active_cds: window.cdNames,
      ability_breakdown,
    });
  }
  return windows.sort((a, b) => a.time_s - b.time_s);
}

/** Cluster per-parse windows across parses into the bench `BurstWindow[]`. */
export function clusterParseWindows(windows: ParseWindow[], sampleCount: number, mergeS = CLUSTER_MERGE_S): BurstWindow[] {
  const result: BurstWindow[] = [];
  for (const cluster of groupByTime(windows, mergeS)) {
    if (cluster.length < Math.max(2, sampleCount * CLUSTER_MIN_FRAC)) continue;
    const damages = cluster.map(member => member.window_damage);

    const abilityDamage = new Map<number, number[]>();
    const abilityCasts = new Map<number, number[]>();
    for (const member of cluster) {
      for (const ability of member.ability_breakdown) {
        if (!abilityDamage.has(ability.spell_id)) {
          abilityDamage.set(ability.spell_id, []);
          abilityCasts.set(ability.spell_id, []);
        }
        abilityDamage.get(ability.spell_id)!.push(ability.damage);
        abilityCasts.get(ability.spell_id)!.push(ability.casts);
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
      avg_targets: 1,
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

    const rankings = toParseRankings(await this.wclApi.getRankings(spec, encounterId), TOP_PARSE_COUNT);
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
      const windows = findParseWindows(damage, fight.startTime, timings, casts, abilityNames);
      return { windows, encounterName: fight.name ?? '' };
    } catch (err) {
      logWarn(`BurstTransformService parse ${ranking.report_code}:${ranking.fight_id}`, err);
      return null;
    }
  }
}
