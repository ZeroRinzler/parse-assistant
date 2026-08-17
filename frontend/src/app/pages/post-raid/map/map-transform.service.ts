/** Boss pick: the boss is the actor with the highest observed `maxHitPoints`; this can differ from ingest when an add briefly out-HPs the boss in a snapshot. */
import { Injectable, inject } from '@angular/core';
import { WclApiService } from '../../../core/services/wcl-api';
import { DataFileApiService } from '../../../core/services/data-file-api';
import { WclEvent, WclFight, ParseRanking } from '../../../core/models/wcl.models';
import { ParsePositions, PlayerPosRow, PosRow } from '../../../core/models/positioning.models';
import { logWarn } from '../../../core/log';
import { Result, ok, missing } from '../../../core/result';
import { toLoadError } from '../../../core/http-load-error';
import { TimedEvent, findParseActor, relativeS, toParseRankings, unwrapRankings, withRelativeS } from '../../../shared/analysis/wcl-projections';
import { posActorId } from './map-positions';
import { DataSource } from '../../../core/data-source/data-source';
import { MapData } from './map-data-source';

export { posActorId } from './map-positions';

/** How many top parses to sample (matches the ingest bench). */
const TOP_PARSE_COUNT = 10;
// Over-fetches so a private/unfetchable top parse can be backfilled by the next-best one; the break in the loop caps actual fetches at TOP_PARSE_COUNT.
const CANDIDATE_POOL_COUNT = TOP_PARSE_COUNT * 2;
/** Fixed resample cadence, seconds (mirrors ingest `POSITIONS_INTERVAL_S`). */
const POSITIONS_INTERVAL_S = 1.5;
const MAX_TRACKED_ENEMIES = 5;
const MIN_ENEMY_SAMPLES = 4;
// Times/durations are stored rounded to deciseconds (0.1s): multiply, round, divide.
const DECISECONDS_PER_S = 10;

export interface RawPosSample {
  t: number;
  x: number;
  y: number;
  facing: number | null;
  mapID: number | null;
  maxHp: number;
}

/** `maxHitPoints` is on the wire with `includeResources`; 0 when absent. */
function eventMaxHp(event: TimedEvent): number {
  return typeof event.maxHitPoints === 'number' ? event.maxHitPoints : 0;
}

export function collectPositionSamples(events: TimedEvent[]): Map<number, RawPosSample[]> {
  const byActor = new Map<number, RawPosSample[]>();
  for (const event of events) {
    const actorId = posActorId(event);
    if (actorId == null || event.x == null || event.y == null) continue;
    let samples = byActor.get(actorId);
    if (!samples) { samples = []; byActor.set(actorId, samples); }
    samples.push({
      t: event.atS,
      x: event.x, y: event.y,
      facing: typeof event.facing === 'number' ? event.facing : null,
      mapID: typeof event.mapID === 'number' ? event.mapID : null,
      maxHp: eventMaxHp(event),
    });
  }
  for (const samples of byActor.values()) samples.sort((a, b) => a.t - b.t);
  return byActor;
}

interface CadencePoint { t: number; x: number; y: number; nearest: RawPosSample; }

function resamplePoints(samples: RawPosSample[], durationS: number, intervalS: number): CadencePoint[] {
  const firstSample = samples[0];
  if (!firstSample) return [];
  const first = firstSample.t;
  const last = samples.reduce((latest, sample) => Math.max(latest, sample.t), first);
  const out: CadencePoint[] = [];
  // Cursor over the sample stream: `before` is the latest sample at or before `t`, `after` the next one (absent past the end).
  const upcoming = samples.slice(1)[Symbol.iterator]();
  const advance = (): RawPosSample | undefined => {
    const next = upcoming.next();
    return next.done ? undefined : next.value;
  };
  let before = firstSample;
  let after = advance();
  for (let t = 0; t <= durationS + 1e-6; t += intervalS) {
    if (t < first - intervalS || t > last + intervalS) continue;
    while (after !== undefined && after.t <= t) { before = after; after = advance(); }
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

interface EnemyCandidate {
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

/** The `MIN_ENEMY_SAMPLES` floor is applied later on resampled rows, not here. */
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
  posEvents: TimedEvent[];
  durationS: number;
}

/** Enemies are keyed by gameID so the frontend matches "the same boss/add" across parses. */
export function buildParsePositions(input: ParsePositionInput): ParsePositions {
  const { reportCode, fightId, playerName, playerId, enemyMetaById, posEvents, durationS } = input;
  const byActor = collectPositionSamples(posEvents);
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
      game_id: enemy.meta.gameID,
      name: enemy.meta.name,
      is_boss: enemy.actorId === bossId,
      samples: resampleTimeline(enemy.samples, durationS, POSITIONS_INTERVAL_S),
    })).filter(enemy => enemy.is_boss || enemy.samples.length >= MIN_ENEMY_SAMPLES),
  };
}

@Injectable({ providedIn: 'root' })
export class MapTransformService implements DataSource<MapData> {
  private readonly wclApi = inject(WclApiService);
  private readonly dataFiles = inject(DataFileApiService);

  async getBench(spec: string, encounterId: number, partition?: number | null): Promise<Result<MapData>> {
    try {
      const rankings = toParseRankings(unwrapRankings(await this.wclApi.getRankings(spec, encounterId, partition)), CANDIDATE_POOL_COUNT);
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

  private async computeParse(
    ranking: ParseRanking,
  ): Promise<{ positions: ParsePositions; encounterName: string } | null> {
    try {
      const report = await this.wclApi.getReport(ranking.report_code);
      const fight = report.fights.find(entry => entry.id === ranking.fight_id);
      const player = findParseActor(report.masterData?.actors, ranking);
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
        posEvents: withRelativeS(posEvents, fight.startTime),
        durationS: relativeS(fight.endTime, fight.startTime),
      });
      return { positions, encounterName: fight.name };
    } catch (cause) {
      logWarn(`MapTransformService parse ${ranking.report_code}:${ranking.fight_id}`, cause);
      return null;
    }
  }

  /** The enemy fetch needs `hostilityType: 'Enemies'` because the events query defaults to Friendlies. */
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
