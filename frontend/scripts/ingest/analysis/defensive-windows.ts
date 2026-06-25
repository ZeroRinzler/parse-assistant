/**
 * Transform layer - defensive window detection and clustering (pure).
 *
 * Per-parse: for each defensive, slice the damage-taken stream by the buff's
 * active windows and record absolute damage + the dominant enemy. Across parses:
 * cluster per-defensive first (so two defensives at the same time stay separate),
 * then by time within each defensive group.
 */

import { mean, round, groupByTime, clusterBaseStats } from './stats.ts';
import { CLUSTER_MIN_FRAC } from './thresholds.ts';
import type { RulebookDefensive } from '../../../src/app/core/models/rulebook.models.ts';
import type { WclResourceEvent, WclActorEntry } from '../models/wcl.models.ts';
import type { RawDefensiveWindow, RawDefensiveWindowAbility } from '../models/parse-sample.models.ts';
import type { ClusteredDefensiveWindow } from '../models/bench.models.ts';

export function findDefensiveWindows(
  damageTakenEvents: WclResourceEvent[], fightStartMs: number,
  buffWindows: Map<number, Array<[number, number | null]>>,
  specDefensives: RulebookDefensive[],
  npcById: Map<number, WclActorEntry>,
): RawDefensiveWindow[] {
  const hits = damageTakenEvents
    .filter(event => event.type === 'damage' && (event.amount ?? 0) + (event.absorbed ?? 0) > 0)
    .map(event => [event.timestamp, (event.amount ?? 0) + (event.absorbed ?? 0), event.abilityGameID ?? 0, event.sourceID ?? null] as [number, number, number, number | null])
    .sort((a, b) => a[0] - b[0]);

  if (!hits.length) return [];
  const total = hits.reduce((sum, hit) => sum + hit[1], 0);
  if (!total) return [];

  const result: RawDefensiveWindow[] = [];

  for (const defensive of specDefensives) {
    const spellId = defensive.spell_id;
    const duration = defensive.duration ?? 5;

    for (const buffWindow of (buffWindows.get(spellId) ?? [])) {
      // buffWindows store relative-seconds from fight start.
      const startS = buffWindow[0];
      const endS = buffWindow[1] != null ? buffWindow[1] : startS + duration;
      const startMs = fightStartMs + startS * 1000;
      const endMs = fightStartMs + endS * 1000;

      const windowHits = hits.filter(hit => hit[0] >= startMs && hit[0] <= endMs);
      const windowDmg = windowHits.reduce((sum, hit) => sum + hit[1], 0);
      const pct = total ? Math.round(windowDmg / total * 1000) / 1000 : 0;

      const abilityDmg = new Map<number, number>();
      for (const [, damage, abilityId] of windowHits) {
        if (abilityId) abilityDmg.set(abilityId, (abilityDmg.get(abilityId) ?? 0) + damage);
      }
      const topAbilities: RawDefensiveWindowAbility[] = [...abilityDmg.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([abilityId, damage]) => ({
          spell_id: abilityId,
          damage,
          pct: windowDmg ? Math.round(damage / windowDmg * 1000) / 1000 : 0,
        }));

      // Reference for the map = the enemy that dealt the most damage in the window.
      const dmgBySource = new Map<number, number>();
      for (const [, damage, , sourceId] of windowHits) {
        if (sourceId != null && npcById.has(sourceId)) dmgBySource.set(sourceId, (dmgBySource.get(sourceId) ?? 0) + damage);
      }
      const topSource = [...dmgBySource.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      const refGameId = topSource != null ? (npcById.get(topSource)?.gameID ?? null) : null;

      result.push({
        time_s: Math.round(startS * 10) / 10,
        window_length_s: Math.round((endS - startS) * 10) / 10,
        pct_of_total: pct,
        window_damage: windowDmg,
        total_damage: total,
        ability_breakdown: topAbilities,
        active_cds: [defensive.name],
        defensive_name: defensive.name,
        spell_id: spellId,
        ref_game_id: refGameId ?? null,
      });
    }
  }

  return result.sort((a, b) => a.time_s - b.time_s);
}

export function clusterDefensiveWindows(windows: RawDefensiveWindow[], totalSamples: number, mergeS = 20.0): ClusteredDefensiveWindow[] {
  if (!windows.length) return [];
  const byDefensive = new Map<string, RawDefensiveWindow[]>();
  for (const window of windows) {
    const name = window.defensive_name || window.active_cds?.[0] || '';
    if (!byDefensive.has(name)) byDefensive.set(name, []);
    byDefensive.get(name)!.push(window);
  }
  const result: ClusteredDefensiveWindow[] = [];
  for (const [defensiveName, defensiveWindows] of byDefensive.entries()) {
    for (const cluster of groupByTime(defensiveWindows, mergeS)) {
      if (cluster.length < Math.max(2, totalSamples * CLUSTER_MIN_FRAC)) continue;
      const base = clusterBaseStats(cluster, totalSamples);
      result.push({
        ...base,
        window_length_s: round(mean(cluster.map(member => member.window_length_s))),
        defensive_name: defensiveName,
        spell_id: cluster[0].spell_id,
        common_defensives: [defensiveName],
        common_cds: [defensiveName],
      });
    }
  }
  return result.sort((a, b) => a.time_s - b.time_s);
}
