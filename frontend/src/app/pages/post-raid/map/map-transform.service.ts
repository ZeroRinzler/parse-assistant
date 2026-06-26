/**
 * Dev-flag `MapDataSource`: computes the top-parse position bench live in the
 * browser (no ingestion). Self-contained per the slice rule - it imports ONLY the
 * two API services + models + `logWarn`, and reimplements its own position math
 * below (it does NOT reference the ingest analysis under `scripts/ingest`). Bound
 * by `environment.useLiveTransform`.
 *
 * It fetches the encounter's top parses, refetches each parse's position-bearing
 * events (Casts with `includeResources` for friendlies + enemies, plus the same
 * for the boss's damage so its trail is dense), groups raw samples per actor,
 * resamples to a fixed cadence, and emits the same `EncounterPositions` shape the
 * ingest `savePositions` writes. The colocated pure fns mirror ingest's
 * `positions.ts` but are owned here (duplication over sharing).
 *
 * KNOWN LIMITATION: the WCL report's master `enemies[]` carries gameID + name but
 * the runtime `WclEvent` model does not type `maxHitPoints` (it is on the wire when
 * `includeResources` is on). The boss is therefore picked by the highest observed
 * `maxHitPoints` read defensively off the event, falling back to the most-sampled
 * enemy. This matches ingest closely but is not guaranteed identical for fights
 * where an add briefly out-HPs the boss in a snapshot.
 */
import { Injectable, inject } from '@angular/core';
import { WclApiService } from '../../../core/services/wcl-api';
import { DataFileApiService } from '../../../core/services/data-file-api';
import { WclEvent, WclFight, ParseRanking, WclRawRanking } from '../../../core/models/wcl.models';
import { ParsePositions, PosRow } from '../../../core/models/positioning.models';
import { logWarn } from '../../../core/log';
import { MapData, MapDataSource } from './map-data-source';

/** How many top parses to sample (matches the ingest bench). */
const TOP_PARSE_COUNT = 10;
/** Fixed resample cadence, seconds (mirrors ingest `POSITIONS_INTERVAL_S`). */
export const POSITIONS_INTERVAL_S = 1.5;
/** Keep the boss plus this many most-active enemies. */
const MAX_TRACKED_ENEMIES = 5;
/** A non-boss enemy needs at least this many resampled rows to be kept. */
const MIN_ENEMY_SAMPLES = 4;

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

/** One raw position sample before resampling (raw WCL units; HP for boss pick). */
export interface RawPosSample {
  t: number;
  x: number;
  y: number;
  facing: number | null;
  mapID: number | null;
  maxHp: number;
}

/** The actor a resource-bearing event's flattened position describes (1 = source, 2 = target). */
export function posActorId(event: WclEvent): number | null {
  if (typeof event.x !== 'number' || typeof event.y !== 'number') return null;
  return event.resourceActor === 2 ? (event.sourceID === undefined ? null : event.targetID ?? null) : (event.sourceID ?? null);
}

/** `maxHitPoints` is on the wire with `includeResources` but not in the typed model. */
function eventMaxHp(event: WclEvent): number {
  const hp = (event as unknown as { maxHitPoints?: number }).maxHitPoints;
  return typeof hp === 'number' ? hp : 0;
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

/** Resample to a fixed cadence: [t, x, y, facing, mapID] rows (linear x/y, nearest facing/mapID). */
export function resampleTimeline(samples: RawPosSample[], durationS: number, intervalS: number): PosRow[] {
  if (!samples.length) return [];
  const first = samples[0].t;
  const last = samples[samples.length - 1].t;
  const out: PosRow[] = [];
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

/** gameID + name for a report's enemy actors, keyed by actor id. */
export interface EnemyMeta { gameID: number | null; name: string; }

/**
 * Build one parse's position payload from its resource-bearing events: the ranked
 * player's resampled timeline plus the notable enemy timelines (boss = highest
 * observed maxHitPoints, then the most-sampled enemies). Enemies are keyed by
 * gameID so the frontend matches "the same boss/add" across parses. Mirrors
 * ingest `buildParsePositions`.
 */
export function buildParsePositions(
  reportCode: string, fightId: number, playerName: string, playerId: number,
  enemyMetaById: Map<number, EnemyMeta>, posEvents: WclEvent[],
  fightStartMs: number, durationS: number,
): ParsePositions {
  const byActor = collectPositionSamples(posEvents, fightStartMs);
  const playerSamples = byActor.get(playerId) ?? [];

  const enemies: { actorId: number; count: number; maxHp: number; samples: RawPosSample[]; meta: EnemyMeta }[] = [];
  for (const [actorId, samples] of byActor) {
    if (actorId === playerId || !enemyMetaById.has(actorId)) continue;
    const maxHp = samples.reduce((max, sample) => Math.max(max, sample.maxHp), 0);
    enemies.push({ actorId, count: samples.length, maxHp, samples, meta: enemyMetaById.get(actorId)! });
  }
  enemies.sort((a, b) => b.count - a.count);
  const bossEntry = enemies.reduce<typeof enemies[number] | null>(
    (best, enemy) => (enemy.maxHp > (best?.maxHp ?? -1) ? enemy : best), null);
  const bossId = bossEntry?.actorId ?? null;
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

/* ----------------------------- service shell ----------------------------- */

@Injectable({ providedIn: 'root' })
export class MapTransformService implements MapDataSource {
  private readonly wclApi = inject(WclApiService);
  private readonly dataFiles = inject(DataFileApiService);

  async getMapData(spec: string, encounterId: number): Promise<MapData | null> {
    const rankings = toParseRankings(await this.wclApi.getRankings(spec, encounterId), TOP_PARSE_COUNT);
    if (!rankings.length) return null;

    const parses: ParsePositions[] = [];
    let encounterName = '';
    for (const ranking of rankings) {
      const parse = await this.computeParse(ranking);
      if (!parse) continue;
      parses.push(parse.positions);
      encounterName ||= parse.encounterName;
    }
    if (!parses.length) return null;

    return {
      spec,
      encounter_id: encounterId,
      encounter_name: encounterName,
      interval_s: POSITIONS_INTERVAL_S,
      sample_count: parses.length,
      parses,
    };
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
      const posEvents = await this.fetchPositionEvents(ranking.report_code, fight, player.id, enemyMetaById);

      const positions = buildParsePositions(
        ranking.report_code, fight.id, player.name, player.id,
        enemyMetaById, posEvents, fight.startTime, (fight.endTime - fight.startTime) / 1000,
      );
      return { positions, encounterName: fight.name ?? '' };
    } catch (err) {
      logWarn(`MapTransformService parse ${ranking.report_code}:${ranking.fight_id}`, err);
      return null;
    }
  }

  /** Friendly player casts + enemy casts (both with positions), so player + enemies have trails. */
  private async fetchPositionEvents(
    reportCode: string, fight: WclFight, playerId: number, enemyMetaById: Map<number, EnemyMeta>,
  ): Promise<WclEvent[]> {
    const { id, startTime, endTime } = fight;
    const bossActorId = enemyMetaById.size ? [...enemyMetaById.keys()][0] : undefined;
    const [playerCasts, enemyCasts, bossDamage] = await Promise.all([
      this.wclApi.getAllEvents(reportCode, id, 'Casts', startTime, endTime, playerId, true),
      this.wclApi.getAllEvents(reportCode, id, 'Casts', startTime, endTime, undefined, true, 'Enemies'),
      bossActorId != null
        ? this.wclApi.getAllEvents(reportCode, id, 'DamageDone', startTime, endTime, bossActorId, true)
        : Promise.resolve([] as WclEvent[]),
    ]);
    return [...playerCasts, ...enemyCasts, ...bossDamage];
  }
}
