/**
 * Transform layer - statistics primitives and the shared cluster-stats helper.
 *
 * Pure functions only (no network, no filesystem). The guarded delegators to
 * simple-statistics preserve the zero-on-empty / zero-on-single contract the
 * call sites rely on (ss.mean/ss.median throw on empty input;
 * sampleStandardDeviation needs n >= 2). `stdev` uses the sample (n-1) standard
 * deviation.
 */

import * as ss from 'simple-statistics';
import { MEMBER_MAJORITY_FRAC } from './thresholds.ts';
import type { ClusterBaseStats } from '../models/bench.models.ts';

export function median(values: number[]): number {
  return values.length ? ss.median(values) : 0;
}

export function mean(values: number[]): number {
  return values.length ? ss.mean(values) : 0;
}

export function stdev(values: number[]): number {
  return values.length >= 2 ? ss.sampleStandardDeviation(values) : 0;
}

export function round(value: number, decimals = 1): number {
  return Math.round(value * 10 ** decimals) / 10 ** decimals;
}

// Median of an already-ascending-sorted array (O(1)); matches median() exactly.
function medianOfSorted(sortedTimes: number[]): number {
  const mid = sortedTimes.length >> 1;
  return sortedTimes.length % 2
    ? sortedTimes[mid]
    : (sortedTimes[mid - 1] + sortedTimes[mid]) / 2;
}

// Group windows by proximity in time (within mergeS seconds of the running cluster
// median). Single O(N) pass: windows are processed in ascending time order, so the
// moment a new cluster is created every earlier cluster's median is already below
// w - mergeS and (since later windows only increase) can never match again. Hence
// only the most-recently-created cluster is ever a candidate.
export function groupByTime<T extends { time_s: number }>(windows: T[], mergeS: number): T[][] {
  const sorted = [...windows].sort((a, b) => a.time_s - b.time_s);
  const clusters: T[][] = [];
  let openTimes: number[] = []; // ascending times of the last (only open) cluster
  for (const window of sorted) {
    if (clusters.length && Math.abs(window.time_s - medianOfSorted(openTimes)) <= mergeS) {
      clusters[clusters.length - 1].push(window);
      openTimes.push(window.time_s); // window.time_s >= every prior time, so still sorted
    } else {
      clusters.push([window]);
      openTimes = [window.time_s];
    }
  }
  return clusters;
}

// Common statistics for a cluster of windows (time, absolute damage, ability
// breakdown). Windows are compared by absolute damage rather than
// share-of-fight-total: on progression (wipes) the fight-total denominator is
// unstable, so a share would inflate against full-kill top parses.
export function clusterBaseStats(
  cluster: Array<{ time_s: number; window_damage?: number; ability_breakdown?: Array<{ spell_id: number; damage?: number; casts?: number }>; ref_game_id?: number | null }>,
  totalSamples: number,
): ClusterBaseStats {
  const times = cluster.map(member => member.time_s);
  const damages = cluster.map(member => member.window_damage ?? 0);
  const sortedDamages = [...damages].sort((a, b) => a - b);

  const abilityTotals = new Map<number, number[]>();
  const abilityCasts = new Map<number, number[]>();
  for (const member of cluster) {
    for (const ability of (member.ability_breakdown ?? [])) {
      if (!abilityTotals.has(ability.spell_id)) abilityTotals.set(ability.spell_id, []);
      abilityTotals.get(ability.spell_id)!.push(ability.damage ?? 0);
      // Cast counts only exist on burst windows; defensive windows omit them.
      if (ability.casts != null) {
        if (!abilityCasts.has(ability.spell_id)) abilityCasts.set(ability.spell_id, []);
        abilityCasts.get(ability.spell_id)!.push(ability.casts);
      }
    }
  }
  const ability_breakdown: ClusterBaseStats['ability_breakdown'] = [...abilityTotals.entries()]
    .filter(([, damageList]) => damageList.length >= cluster.length * MEMBER_MAJORITY_FRAC)
    .map(([spellId, damageList]) => {
      const castsList = abilityCasts.get(spellId);
      const entry: ClusterBaseStats['ability_breakdown'][number] = {
        spell_id: spellId,
        avg_damage: Math.round(mean(damageList)),
        min_damage: Math.round(Math.min(...damageList)),
        max_damage: Math.round(Math.max(...damageList)),
        count: damageList.length,
      };
      if (castsList?.length) entry.avg_casts = Math.round(mean(castsList));
      return entry;
    })
    .sort((a, b) => b.avg_damage - a.avg_damage)
    .slice(0, 6);

  // Majority map-reference enemy across members (defensive windows only; null for burst).
  const refCounts = new Map<number, number>();
  for (const member of cluster) {
    if (member.ref_game_id != null) refCounts.set(member.ref_game_id, (refCounts.get(member.ref_game_id) ?? 0) + 1);
  }
  const ref_game_id = [...refCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  return {
    time_s: round(median(times)),
    stddev_s: round(stdev(times)),
    count: cluster.length,
    total_samples: totalSamples,
    dmg_avg: Math.round(mean(damages)),
    dmg_stddev: Math.round(stdev(damages)),
    dmg_min: Math.round(sortedDamages[0]),
    dmg_max: Math.round(sortedDamages[sortedDamages.length - 1]),
    ability_breakdown,
    ref_game_id,
  };
}
