/**
 * Transform layer - burst window detection and clustering (pure).
 *
 * Per-parse: build candidate windows from CD cast times x CD durations, merge
 * near-adjacent ones, and keep those above a damage-share threshold. Across
 * parses: cluster windows by time and surface the common CDs/abilities.
 */

import { mean, round, groupByTime, clusterBaseStats } from './stats.ts';
import { CLUSTER_MIN_FRAC, MEMBER_MAJORITY_FRAC } from './thresholds.ts';
import type { RulebookCooldown } from '../../../src/app/core/models/rulebook.models.ts';
import type { WclResourceEvent } from '../models/wcl.models.ts';
import type { CdCastSummary, RawBurstWindow, RawBurstWindowAbility } from '../models/parse-sample.models.ts';
import type { ClusteredBurstWindow } from '../models/bench.models.ts';

export function findBurstWindows(
  damageEvents: WclResourceEvent[], fightStartMs: number,
  cdSummary: CdCastSummary[], specCds: RulebookCooldown[],
  minPctThreshold = 0.03, castEvents: WclResourceEvent[] = [],
): RawBurstWindow[] {
  const hits = damageEvents
    .filter(event => event.type === 'damage' && (event.amount ?? 0) + (event.absorbed ?? 0) > 0)
    .map(event => [event.timestamp, (event.amount ?? 0) + (event.absorbed ?? 0), event.targetID ?? 0, event.abilityGameID ?? 0] as [number, number, number, number])
    .sort((a, b) => a[0] - b[0]);

  // Cast timestamps per ability - used to count player casts inside each window.
  const casts = castEvents
    .filter(event => event.type === 'cast' && event.abilityGameID)
    .map(event => [event.timestamp, event.abilityGameID!] as [number, number]);

  if (!hits.length) return [];
  const total = hits.reduce((sum, hit) => sum + hit[1], 0);
  if (!total) return [];

  // Build windows from CD cast times x CD durations.
  const rawWindows: Array<{ startS: number; endS: number; cdNames: string[] }> = [];
  for (const cdEntry of cdSummary) {
    const cdDef = specCds.find(cooldown => cooldown.name === cdEntry.name);
    const duration = cdDef?.duration ?? 0;
    if (duration <= 0) continue;
    for (const castS of (cdEntry.cast_times_s ?? [])) {
      rawWindows.push({ startS: castS, endS: castS + duration, cdNames: [cdEntry.name] });
    }
  }
  if (!rawWindows.length) return [];

  // Merge overlapping or near-adjacent windows (<= 3s gap).
  rawWindows.sort((a, b) => a.startS - b.startS);
  const merged: Array<{ startS: number; endS: number; cdNames: string[] }> = [{ ...rawWindows[0], cdNames: [...rawWindows[0].cdNames] }];
  for (let i = 1; i < rawWindows.length; i++) {
    const prev = merged[merged.length - 1];
    const current = rawWindows[i];
    if (current.startS <= prev.endS + 3) {
      prev.endS = Math.max(prev.endS, current.endS);
      for (const name of current.cdNames) { if (!prev.cdNames.includes(name)) prev.cdNames.push(name); }
    } else {
      merged.push({ ...current, cdNames: [...current.cdNames] });
    }
  }

  const result: RawBurstWindow[] = [];
  for (const window of merged) {
    const startMs = fightStartMs + window.startS * 1000;
    const endMs = fightStartMs + window.endS * 1000;
    const windowHits = hits.filter(hit => hit[0] >= startMs && hit[0] <= endMs);
    const windowDmg = windowHits.reduce((sum, hit) => sum + hit[1], 0);
    if (!windowDmg || windowDmg / total < minPctThreshold) continue;

    const abilityDmg = new Map<number, number>();
    for (const [, damage, , abilityId] of windowHits) {
      if (abilityId) abilityDmg.set(abilityId, (abilityDmg.get(abilityId) ?? 0) + damage);
    }
    // Count casts per ability inside the window (boundary matches damage hits: [start, end]).
    const abilityCasts = new Map<number, number>();
    for (const [timestamp, abilityId] of casts) {
      if (timestamp >= startMs && timestamp <= endMs) abilityCasts.set(abilityId, (abilityCasts.get(abilityId) ?? 0) + 1);
    }
    const topAbilities: RawBurstWindowAbility[] = [...abilityDmg.entries()]
      .sort((a, b) => b[1] - a[1]).slice(0, 6)
      .map(([spellId, damage]) => ({ spell_id: spellId, damage, pct: Math.round(damage / windowDmg * 1000) / 1000, casts: abilityCasts.get(spellId) ?? 0 }));

    result.push({
      time_s: Math.round(window.startS * 10) / 10,
      window_length_s: Math.round((window.endS - window.startS) * 10) / 10,
      pct_of_total: Math.round(windowDmg / total * 1000) / 1000,
      window_damage: windowDmg,
      total_damage: total,
      ability_breakdown: topAbilities,
      active_cds: window.cdNames,
      target_count: 1,
    });
  }
  return result.sort((a, b) => a.time_s - b.time_s);
}

export function clusterBurstWindows(windows: RawBurstWindow[], totalSamples: number, mergeS = 15.0): ClusteredBurstWindow[] {
  if (!windows.length) return [];
  const result: ClusteredBurstWindow[] = [];
  for (const cluster of groupByTime(windows, mergeS)) {
    if (cluster.length < Math.max(2, totalSamples * CLUSTER_MIN_FRAC)) continue;
    const base = clusterBaseStats(cluster, totalSamples);
    const cdCounts = new Map<string, number>();
    for (const member of cluster) {
      for (const name of (member.active_cds ?? [])) cdCounts.set(name, (cdCounts.get(name) ?? 0) + 1);
    }
    const common_cds = [...cdCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .filter(([, count]) => count >= cluster.length * MEMBER_MAJORITY_FRAC)
      .map(([name]) => name);
    const window_length_s = round(mean(cluster.map(member => member.window_length_s)));
    result.push({ ...base, common_cds, avg_targets: round(mean(cluster.map(member => member.target_count ?? 1))), window_length_s });
  }
  return result.sort((a, b) => a.time_s - b.time_s);
}
