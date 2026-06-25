/**
 * Transform layer - position timelines (pure).
 *
 * Positions come from events fetched with includeResources:true, which flattens
 * one actor's snapshot onto the event (top-level x/y/facing/mapID); resourceActor
 * says whose (1 = source, 2 = target). x/y are hundredths of a yard, facing
 * milliradians - stored raw here and scaled by the frontend (positioning-core).
 */

import type { ParsePositions } from '../../../src/app/core/models/positioning.models.ts';
import type { WclResourceEvent, WclActorEntry } from '../models/wcl.models.ts';

export const POSITIONS_INTERVAL_S = 1.5;
const MAX_TRACKED_ENEMIES = 5;
const MIN_ENEMY_SAMPLES = 4;

// Position sample before resampling.
interface RawPosSample {
  t: number;
  x: number;
  y: number;
  facing: number | null;
  mapID: number | null;
  maxHp: number;
}

interface EnemyWithSamples {
  actorId: number;
  count: number;
  maxHp: number;
  samples: RawPosSample[];
  meta: WclActorEntry;
}

export function posActorId(event: WclResourceEvent): number | null {
  if (typeof event.x !== 'number' || typeof event.y !== 'number') return null;
  return event.resourceActor === 2 ? (event.targetID ?? null) : (event.sourceID ?? null);
}

/** Boss actor id = the NPC with the highest maxHitPoints across resource snapshots. */
export function pickBossActorId(events: WclResourceEvent[], npcById: Map<number, WclActorEntry>): number | null {
  const maxHp = new Map<number, number>();
  for (const event of events) {
    const actorId = posActorId(event);
    if (actorId == null || !npcById.has(actorId)) continue;
    const hp = typeof event.maxHitPoints === 'number' ? event.maxHitPoints : 0;
    if (hp > (maxHp.get(actorId) ?? -1)) maxHp.set(actorId, hp);
  }
  let bossId: number | null = null, best = -1;
  for (const [actorId, hp] of maxHp) if (hp > best) { best = hp; bossId = actorId; }
  return bossId;
}

/** Group raw position samples per actor id from resource-bearing events. */
export function collectPositionSamples(events: WclResourceEvent[], fightStartMs: number): Map<number, RawPosSample[]> {
  const byActor = new Map<number, RawPosSample[]>();
  for (const event of events) {
    const actorId = posActorId(event);
    if (actorId == null) continue;
    let samples = byActor.get(actorId);
    if (!samples) { samples = []; byActor.set(actorId, samples); }
    samples.push({
      t: (event.timestamp - fightStartMs) / 1000,
      x: event.x!, y: event.y!,
      facing: typeof event.facing === 'number' ? event.facing : null,
      mapID: typeof event.mapID === 'number' ? event.mapID : null,
      maxHp: typeof event.maxHitPoints === 'number' ? event.maxHitPoints : 0,
    });
  }
  for (const samples of byActor.values()) samples.sort((a, b) => a.t - b.t);
  return byActor;
}

/** Resample to a fixed cadence: [t, x, y, facing, mapID] rows, linear for x/y, nearest for facing/mapID. */
export function resampleTimeline(samples: RawPosSample[], durationS: number, intervalS: number): ParsePositions['player'] {
  if (!samples.length) return [];
  const first = samples[0].t, last = samples[samples.length - 1].t;
  const out: ParsePositions['player'] = [];
  let idx = 0;
  for (let t = 0; t <= durationS + 1e-6; t += intervalS) {
    if (t < first - intervalS || t > last + intervalS) continue;
    while (idx + 1 < samples.length && samples[idx + 1].t <= t) idx++;
    const before = samples[idx];
    const after = samples[idx + 1];
    let x = before.x, y = before.y, nearest = before;
    if (after && after.t > before.t && t >= before.t) {
      const fraction = Math.min(1, Math.max(0, (t - before.t) / (after.t - before.t)));
      x = before.x + (after.x - before.x) * fraction;
      y = before.y + (after.y - before.y) * fraction;
      nearest = fraction < 0.5 ? before : after;
    }
    out.push([
      Math.round(t * 10) / 10, Math.round(x), Math.round(y),
      nearest.facing == null ? null : Math.round(nearest.facing), nearest.mapID,
    ]);
  }
  return out;
}

/**
 * Build the per-parse position payload: the ranked player's timeline plus the
 * notable enemy timelines (boss = highest maxHitPoints). Enemies are keyed by
 * gameID so the frontend can match "the same boss/add" across parses.
 */
export function buildParsePositions(
  reportCode: string, fightId: number, playerName: string, playerId: number,
  npcById: Map<number, WclActorEntry>, posEvents: WclResourceEvent[],
  fightStartMs: number, durationS: number,
): ParsePositions {
  const byActor = collectPositionSamples(posEvents, fightStartMs);
  const playerSamples = byActor.get(playerId) ?? [];

  const enemies: EnemyWithSamples[] = [];
  for (const [actorId, samples] of byActor) {
    if (actorId === playerId || !npcById.has(actorId)) continue;
    const maxHp = samples.reduce((max, sample) => Math.max(max, sample.maxHp), 0);
    enemies.push({ actorId, count: samples.length, maxHp, samples, meta: npcById.get(actorId)! });
  }
  enemies.sort((a, b) => b.count - a.count);
  const bossEntry = enemies.reduce<EnemyWithSamples | null>((best, enemy) => (enemy.maxHp > (best?.maxHp ?? -1) ? enemy : best), null);
  const bossId = bossEntry?.actorId ?? null;
  // Keep the boss plus the most-active enemies (likely add/mechanic casters).
  const kept = enemies.slice(0, MAX_TRACKED_ENEMIES);
  if (bossId != null && !kept.some(enemy => enemy.actorId === bossId)) {
    const boss = enemies.find(enemy => enemy.actorId === bossId);
    if (boss) kept.push(boss);
  }

  return {
    report_code: reportCode,
    fight_id: fightId,
    player_name: playerName,
    duration_s: Math.round(durationS * 10) / 10,
    interval_s: POSITIONS_INTERVAL_S,
    player: resampleTimeline(playerSamples, durationS, POSITIONS_INTERVAL_S),
    enemies: kept.map(enemy => ({
      game_id: enemy.meta.gameID ?? null,
      name: enemy.meta.name ?? '',
      is_boss: enemy.actorId === bossId,
      samples: resampleTimeline(enemy.samples, durationS, POSITIONS_INTERVAL_S),
    })).filter(enemy => enemy.is_boss || enemy.samples.length >= MIN_ENEMY_SAMPLES),
  };
}
