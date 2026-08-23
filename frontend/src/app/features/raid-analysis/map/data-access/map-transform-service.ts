/** Boss pick: the boss is the actor with the highest observed `maxHitPoints`; this can differ from ingest when an add briefly out-HPs the boss in a snapshot. */
import { Injectable, inject } from '@angular/core';
import { WclApiService } from '../../../../core/wcl/wcl-api-service';
import { DataFileApiService } from '../../../../core/data-files/data-file-api-service';
import { TopParseSelection, WclEvent, WclFight } from '../../../../core/wcl/wcl.models';
import { ParsePositions, PlayerPosRow, PosRow } from '../../../../domain/encounter/positioning.models';
import { Result } from '../../../../core/http/result';
import { WclProjectionsService, TimedEvent } from '../../../../domain/analysis/wcl-projections-service';
import { BenchPipelineService, BenchParse } from '../../../../domain/analysis/bench-pipeline-service';
import { DataSource } from '../../../../core/data-source/data-source';
import { MapData } from './map-data-source';
import { MapDrawService } from '../domain/map-draw-service';

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

interface CadencePoint { t: number; x: number; y: number; nearest: RawPosSample; }

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

export interface ParsePositionInput {
  reportCode: string;
  fightId: number;
  playerName: string;
  playerId: number;
  enemyMetaById: Map<number, EnemyMeta>;
  posEvents: TimedEvent[];
  durationS: number;
}

@Injectable({ providedIn: 'root' })
export class MapTransformService implements DataSource<MapData> {
  private readonly mapDraw = inject(MapDrawService);
  private readonly benchPipeline = inject(BenchPipelineService);
  private readonly wclProjections = inject(WclProjectionsService);
  private readonly wclApi = inject(WclApiService);
  private readonly dataFiles = inject(DataFileApiService);

  async getBench(spec: string, encounterId: number, selection?: TopParseSelection): Promise<Result<MapData>> {
    return this.benchPipeline.benchFromTopParses(this.wclApi, { spec, encounterId, selection }, {
      logSource: 'MapTransformService',
      errorId: 'map.bench',
      noRankingsMessage: 'No top parses for this encounter.',
      tooFewParsesMessage: () => 'No fetchable top parses for this encounter.',
      parse: parse => this.parsePositions(parse),
      bench: ({ parses }) => ({ interval_s: POSITIONS_INTERVAL_S, parses }),
    });
  }

  private async parsePositions({ ranking, report, fight, player }: BenchParse): Promise<ParsePositions> {
    const enemyMetaById = new Map<number, EnemyMeta>(
      (report.masterData?.enemies ?? []).map(enemy => [enemy.id, { gameID: enemy.gameID, name: enemy.name }]),
    );
    const posEvents = await this.fetchPositionEvents(ranking.report_code, fight, player.id);

    return this.buildParsePositions({
      reportCode: ranking.report_code,
      fightId: fight.id,
      playerName: player.name,
      playerId: player.id,
      enemyMetaById,
      posEvents: this.wclProjections.withRelativeS(posEvents, fight.startTime),
      durationS: this.wclProjections.relativeS(fight.endTime, fight.startTime),
    });
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

  /** `maxHitPoints` is on the wire with `includeResources`; 0 when absent. */
  private eventMaxHp(event: TimedEvent): number {
    return typeof event.maxHitPoints === 'number' ? event.maxHitPoints : 0;
  }

  protected collectPositionSamples(events: TimedEvent[]): Map<number, RawPosSample[]> {
    const byActor = new Map<number, RawPosSample[]>();
    for (const event of events) {
      const actorId = this.mapDraw.posActorId(event);
      if (actorId == null || event.x == null || event.y == null) continue;
      let samples = byActor.get(actorId);
      if (!samples) { samples = []; byActor.set(actorId, samples); }
      samples.push({
        t: event.atS,
        x: event.x, y: event.y,
        facing: typeof event.facing === 'number' ? event.facing : null,
        mapID: typeof event.mapID === 'number' ? event.mapID : null,
        maxHp: this.eventMaxHp(event),
      });
    }
    for (const samples of byActor.values()) samples.sort((a, b) => a.t - b.t);
    return byActor;
  }

  private interpolateAt(
    before: RawPosSample, after: RawPosSample | undefined, t: number,
  ): { x: number; y: number; nearest: RawPosSample } {
    if (!after || after.t <= before.t || t < before.t) return { x: before.x, y: before.y, nearest: before };
    const fraction = Math.min(1, Math.max(0, (t - before.t) / (after.t - before.t)));
    const nearest = fraction < 0.5 ? before : after;
    // coords compare only within one mapID, so snap to the nearest sample rather than blend across a map swap
    if (before.mapID !== after.mapID) return { x: nearest.x, y: nearest.y, nearest };
    return {
      x: before.x + (after.x - before.x) * fraction,
      y: before.y + (after.y - before.y) * fraction,
      nearest,
    };
  }

  private resamplePoints(samples: RawPosSample[], durationS: number, intervalS: number): CadencePoint[] {
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
      const { x, y, nearest } = this.interpolateAt(before, after, t);
      out.push({ t: Math.round(t * DECISECONDS_PER_S) / DECISECONDS_PER_S, x: Math.round(x), y: Math.round(y), nearest });
    }
    return out;
  }

  protected resampleTimeline(samples: RawPosSample[], durationS: number, intervalS: number): PosRow[] {
    return this.resamplePoints(samples, durationS, intervalS).map(({ t, x, y, nearest }) => [
      t, x, y, nearest.facing == null ? null : Math.round(nearest.facing), nearest.mapID,
    ]);
  }

  /** Resample the player timeline to [t, x, y, mapID] rows. Only the reference frame reads facing, so player rows store none. */
  protected resamplePlayerTimeline(samples: RawPosSample[], durationS: number, intervalS: number): PlayerPosRow[] {
    return this.resamplePoints(samples, durationS, intervalS).map(({ t, x, y, nearest }) => [t, x, y, nearest.mapID]);
  }

  /** The `MIN_ENEMY_SAMPLES` floor is applied later on resampled rows, not here. */
  protected selectBossAndEnemies(
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

  /** Enemies are keyed by gameID so the frontend matches "the same boss/add" across parses. */
  protected buildParsePositions(input: ParsePositionInput): ParsePositions {
    const { reportCode, fightId, playerName, playerId, enemyMetaById, posEvents, durationS } = input;
    const byActor = this.collectPositionSamples(posEvents);
    const playerSamples = byActor.get(playerId) ?? [];
    const { bossId, kept } = this.selectBossAndEnemies(byActor, playerId, enemyMetaById);

    return {
      report_code: reportCode,
      fight_id: fightId,
      player_name: playerName,
      duration_s: Math.round(durationS * DECISECONDS_PER_S) / DECISECONDS_PER_S,
      interval_s: POSITIONS_INTERVAL_S,
      player: this.resamplePlayerTimeline(playerSamples, durationS, POSITIONS_INTERVAL_S),
      enemies: kept.map(enemy => ({
        game_id: enemy.meta.gameID,
        name: enemy.meta.name,
        is_boss: enemy.actorId === bossId,
        samples: this.resampleTimeline(enemy.samples, durationS, POSITIONS_INTERVAL_S),
      })).filter(enemy => enemy.is_boss || enemy.samples.length >= MIN_ENEMY_SAMPLES),
    };
  }
}
