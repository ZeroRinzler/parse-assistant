/**
 * Live `DataSource<MapData>`: computes the top-parse position bench in the browser (no ingestion).
 * Fetches each top parse's position-bearing events (Casts with `includeResources` for friendlies +
 * enemies), groups samples per actor, resamples to a fixed cadence, and emits `EncounterPositions`.
 * The pure position math is owned here (self-contained, per the layer rules). Bound by
 * `environment.useLiveTransform`; ingestion drives this same service.
 *
 * Boss pick: the WCL master `enemies[]` carries gameID + name but no HP, so the boss is the actor
 * with the highest observed `maxHitPoints` (flattened onto events by `includeResources`). This can
 * differ from ingest when an add briefly out-HPs the boss in a snapshot.
 */
import { Injectable, inject } from '@angular/core';
import { WclApiService } from '../../../core/services/wcl-api';
import { DataFileApiService } from '../../../core/services/data-file-api';
import { WclEvent, WclFight, ParseRanking } from '../../../core/models/wcl.models';
import { ParsePositions, PlayerPosRow, PosRow } from '../../../core/models/positioning.models';
import { logWarn } from '../../../core/log';
import { Result, LoadError, ok, missing } from '../../../core/result';
import { toLoadError } from '../../../core/http-load-error';
import { toParseRankings, unwrapRankings } from '../../../shared/analysis/wcl-projections';
import { posActorId } from './map-positions';
import { DataSource } from '../../../core/data-source/data-source';
import { MapData } from './map-data-source';

// Re-exported so call sites / specs importing these from the transform service keep working.
export { toParseRankings } from '../../../shared/analysis/wcl-projections';
export { posActorId } from './map-positions';

/** How many top parses to sample (matches the ingest bench). */
const TOP_PARSE_COUNT = 10;
// Over-fetch so a private/unfetchable top parse can be backfilled by the
// next-best one; the break in the loop caps actual fetches at TOP_PARSE_COUNT.
const CANDIDATE_POOL_COUNT = TOP_PARSE_COUNT * 2;
/** Fixed resample cadence, seconds (mirrors ingest `POSITIONS_INTERVAL_S`). */
export const POSITIONS_INTERVAL_S = 1.5;
/** Keep the boss plus this many most-active enemies. */
const MAX_TRACKED_ENEMIES = 5;
/** A non-boss enemy needs at least this many resampled rows to be kept. */
const MIN_ENEMY_SAMPLES = 4;
// Times/durations are stored rounded to deciseconds (0.1s): multiply, round, divide.
const DECISECONDS_PER_S = 10;

/** One raw position sample before resampling (raw WCL units; HP for boss pick). */
export interface RawPosSample {
  t: number;
  x: number;
  y: number;
  facing: number | null;
  mapID: number | null;
  maxHp: number;
}

/** `maxHitPoints` is on the wire with `includeResources`; 0 when absent. */
function eventMaxHp(event: WclEvent): number {
  return typeof event.maxHitPoints === 'number' ? event.maxHitPoints : 0;
}

/** Group raw position samples per actor id from resource-bearing events, sorted by time. */
export function collectPositionSamples(events: WclEvent[], fightStartMs: number): Map<number, RawPosSample[]> {
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
      maxHp: eventMaxHp(event),
    });
  }
  for (const samples of byActor.values()) samples.sort((a, b) => a.t - b.t);
  return byActor;
}

/** One cadence point of the shared resample walk, before row projection. */
interface CadencePoint { t: number; x: number; y: number; nearest: RawPosSample; }

/** Walk the fixed cadence: lerp x/y within a mapID, snap to the nearest sample across a mapID change. */
function resamplePoints(samples: RawPosSample[], durationS: number, intervalS: number): CadencePoint[] {
  if (!samples.length) return [];
  const first = samples[0].t;
  const last = samples[samples.length - 1].t;
  const out: CadencePoint[] = [];
  let idx = 0;
  for (let t = 0; t <= durationS + 1e-6; t += intervalS) {
    if (t < first - intervalS || t > last + intervalS) continue;
    while (idx + 1 < samples.length && samples[idx + 1].t <= t) idx++;
    const before = samples[idx];
    const after = samples[idx + 1];
    let x = before.x, y = before.y, nearest = before;
    if (after && after.t > before.t && t >= before.t) {
      const fraction = Math.min(1, Math.max(0, (t - before.t) / (after.t - before.t)));
      nearest = fraction < 0.5 ? before : after;
      if (before.mapID === after.mapID) {
        x = before.x + (after.x - before.x) * fraction;
        y = before.y + (after.y - before.y) * fraction;
      } else {
        // coords compare only within one mapID, so snap to the nearest sample rather than blend across a map swap
        x = nearest.x;
        y = nearest.y;
      }
    }
    out.push({ t: Math.round(t * DECISECONDS_PER_S) / DECISECONDS_PER_S, x: Math.round(x), y: Math.round(y), nearest });
  }
  return out;
}

/** Resample an enemy timeline to [t, x, y, facing, mapID] rows at the fixed cadence. */
export function resampleTimeline(samples: RawPosSample[], durationS: number, intervalS: number): PosRow[] {
  return resamplePoints(samples, durationS, intervalS).map(({ t, x, y, nearest }) => [
    t, x, y, nearest.facing == null ? null : Math.round(nearest.facing), nearest.mapID,
  ]);
}

/** Resample the player timeline to [t, x, y, mapID] rows. Only the reference frame reads facing, so player rows store none. */
export function resamplePlayerTimeline(samples: RawPosSample[], durationS: number, intervalS: number): PlayerPosRow[] {
  return resamplePoints(samples, durationS, intervalS).map(({ t, x, y, nearest }) => [t, x, y, nearest.mapID]);
}

export interface EnemyMeta { gameID: number | null; name: string; }

export interface EnemyCandidate {
  actorId: number;
  count: number;
  maxHp: number;
  samples: RawPosSample[];
  meta: EnemyMeta;
}

export interface SelectedEnemies {
  bossId: number | null;
  kept: EnemyCandidate[];
}

/**
 * Pick the tracked enemy set: the boss is the actor with the highest observed maxHitPoints; the
 * rest rank by sample count, capped at MAX_TRACKED_ENEMIES (the boss is kept even past the cap).
 * The MIN_ENEMY_SAMPLES floor is applied later on resampled rows, not here.
 */
export function selectBossAndEnemies(
  byActor: Map<number, RawPosSample[]>, playerId: number, enemyMetaById: Map<number, EnemyMeta>,
): SelectedEnemies {
  const enemies: EnemyCandidate[] = [];
  for (const [actorId, samples] of byActor) {
    if (actorId === playerId) continue;
    const meta = enemyMetaById.get(actorId);
    if (meta === undefined) continue;
    const maxHp = samples.reduce((max, sample) => Math.max(max, sample.maxHp), 0);
    enemies.push({ actorId, count: samples.length, maxHp, samples, meta });
  }
  enemies.sort((a, b) => b.count - a.count);
  const bossEntry = enemies.reduce<EnemyCandidate | null>(
    (best, enemy) => (enemy.maxHp > (best?.maxHp ?? -1) ? enemy : best), null);
  const bossId = bossEntry?.actorId ?? null;
  const kept = enemies.slice(0, MAX_TRACKED_ENEMIES);
  if (bossId != null && !kept.some(enemy => enemy.actorId === bossId)) {
    const boss = enemies.find(enemy => enemy.actorId === bossId);
    if (boss) kept.push(boss);
  }
  return { bossId, kept };
}

export interface ParsePositionInput {
  reportCode: string;
  fightId: number;
  playerName: string;
  playerId: number;
  enemyMetaById: Map<number, EnemyMeta>;
  posEvents: WclEvent[];
  fightStartMs: number;
  durationS: number;
}

/**
 * Build one parse's position payload: the player's resampled timeline plus notable enemy timelines
 * (boss = highest observed maxHitPoints, then most-sampled). Enemies are keyed by gameID so the
 * frontend matches "the same boss/add" across parses.
 */
export function buildParsePositions(input: ParsePositionInput): ParsePositions {
  const { reportCode, fightId, playerName, playerId, enemyMetaById, posEvents, fightStartMs, durationS } = input;
  const byActor = collectPositionSamples(posEvents, fightStartMs);
  const playerSamples = byActor.get(playerId) ?? [];
  const { bossId, kept } = selectBossAndEnemies(byActor, playerId, enemyMetaById);

  return {
    report_code: reportCode,
    fight_id: fightId,
    player_name: playerName,
    duration_s: Math.round(durationS * DECISECONDS_PER_S) / DECISECONDS_PER_S,
    interval_s: POSITIONS_INTERVAL_S,
    player: resamplePlayerTimeline(playerSamples, durationS, POSITIONS_INTERVAL_S),
    enemies: kept.map(enemy => ({
      game_id: enemy.meta.gameID ?? null,
      name: enemy.meta.name ?? '',
      is_boss: enemy.actorId === bossId,
      samples: resampleTimeline(enemy.samples, durationS, POSITIONS_INTERVAL_S),
    })).filter(enemy => enemy.is_boss || enemy.samples.length >= MIN_ENEMY_SAMPLES),
  };
}

@Injectable({ providedIn: 'root' })
export class MapTransformService implements DataSource<MapData> {
  private readonly wclApi = inject(WclApiService);
  private readonly dataFiles = inject(DataFileApiService);

  async getBench(spec: string, encounterId: number): Promise<Result<MapData, LoadError>> {
    try {
      const rankings = toParseRankings(unwrapRankings(await this.wclApi.getRankings(spec, encounterId)), CANDIDATE_POOL_COUNT);
      if (!rankings.length) return missing('No top parses for this encounter.');

      const parses: ParsePositions[] = [];
      let encounterName = '';
      for (const ranking of rankings) {
        const parse = await this.computeParse(ranking);
        if (!parse) continue;
        parses.push(parse.positions);
        encounterName ||= parse.encounterName;
        if (parses.length >= TOP_PARSE_COUNT) break;
      }
      if (!parses.length) return missing('No fetchable top parses for this encounter.');

      return ok({
        spec,
        encounter_id: encounterId,
        encounter_name: encounterName,
        interval_s: POSITIONS_INTERVAL_S,
        sample_count: parses.length,
        parses,
      });
    } catch (cause) {
      logWarn('MapTransformService.getBench', cause);
      return toLoadError(cause, 'map.bench');
    }
  }

  /** One parse's resampled positions via the colocated pure fns; null if it can't be fetched. */
  private async computeParse(
    ranking: ParseRanking,
  ): Promise<{ positions: ParsePositions; encounterName: string } | null> {
    try {
      const report = await this.wclApi.getReport(ranking.report_code);
      const fight = report.fights.find(entry => entry.id === ranking.fight_id);
      const player = report.masterData?.actors?.find(actor => actor.name === ranking.player);
      if (!fight || !player) return null;

      const enemyMetaById = new Map<number, EnemyMeta>(
        (report.masterData?.enemies ?? []).map(enemy => [enemy.id, { gameID: enemy.gameID, name: enemy.name }]),
      );
      const posEvents = await this.fetchPositionEvents(ranking.report_code, fight, player.id);

      const positions = buildParsePositions({
        reportCode: ranking.report_code,
        fightId: fight.id,
        playerName: player.name,
        playerId: player.id,
        enemyMetaById,
        posEvents,
        fightStartMs: fight.startTime,
        durationS: (fight.endTime - fight.startTime) / 1000,
      });
      return { positions, encounterName: fight.name ?? '' };
    } catch (cause) {
      logWarn(`MapTransformService parse ${ranking.report_code}:${ranking.fight_id}`, cause);
      return null;
    }
  }

  /**
   * Player casts + enemy casts, both with positions (`includeResources`). The enemy fetch needs
   * `hostilityType: 'Enemies'` because the events query defaults to Friendlies; the boss is
   * identified afterward by observed maxHitPoints in `selectBossAndEnemies`.
   */
  private async fetchPositionEvents(
    reportCode: string, fight: WclFight, playerId: number,
  ): Promise<WclEvent[]> {
    const { id, startTime, endTime } = fight;
    const [playerCasts, enemyCasts] = await Promise.all([
      this.wclApi.getAllEvents(reportCode, id, 'Casts', startTime, endTime, playerId, true),
      this.wclApi.getAllEvents(reportCode, id, 'Casts', startTime, endTime, undefined, true, 'Enemies'),
    ]);
    return [...playerCasts, ...enemyCasts];
  }
}
