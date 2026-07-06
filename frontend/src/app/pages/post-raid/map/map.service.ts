/**
 * Map slice: the imperative shell `MapFeatureService` (the only service the components inject)
 * plus the pure positioning functions it uses. The positioning math is owned here as pure fns
 * rather than shared, so the slice stays self-contained.
 */
import { Injectable, Injector, inject, signal } from '@angular/core';
import { WclApiService } from '../../../core/services/wcl-api';
import { WclEvent, WclFight } from '../../../core/models/wcl.models';
import { EncounterPositions, ReferenceSelector } from '../../../core/models/positioning.models';
import { logWarn } from '../../../core/log';
import { Result, LoadError } from '../../../core/result';
import { toLoadError } from '../../../core/http-load-error';
import { posActorId } from './map-positions';
import { MAP_DATA_SOURCE, MapData } from './map-data-source';

/**
 * WoW's `facing` zero-point does not align with our forward axis; empirically a
 * -90 degree offset puts "behind the boss" below the reference.
 */
export const FACING_OFFSET_RAD = -Math.PI / 2;

const RAW_TO_YARDS = 1 / 100;
const FACING_TO_RAD = 1 / 1000;

/** One actor position sample: time fight-relative (s), x/y in yards. */
export interface PosSample {
  t: number;
  x: number;
  y: number;
  facing?: number;
  /** Positions are only comparable within one mapID (map/phase). */
  mapID?: number;
}

export interface ActorTimeline {
  id: number;
  samples: PosSample[];
}

/** Live player overlay: live-pull timelines plus how to resolve the reference actor per selector. */
export interface MapLiveOverlay {
  timelines: Map<number, ActorTimeline>;
  playerId: number;
  bossActorId: number | null;
  /** gameID -> live actor id, so a chosen enemy reference maps to this pull's actor. */
  refActorByGameId: Map<number, number>;
}

export interface MapEnemyActor { id: number; name: string; gameID: number; }

/** Captured by `prepare`; the expensive position-event fetch waits until the map first opens. */
interface PendingOverlay {
  reportCode: string;
  fight: WclFight;
  playerId: number;
  positions: EncounterPositions;
  enemies: MapEnemyActor[];
}

/** The anchor a feature card emits (and the page forwards) to open the map. */
export interface MapAnchor {
  timeS: number;
  /**
   * A window plays its exact span (`timeS` to `timeS + windowLengthS`); a point-in-time cast
   * omits it (0/undefined) and gets pre/post padding instead.
   */
  windowLengthS?: number;
  /** Optional reference override; defaults to the boss. */
  reference?: ReferenceSelector;
}

/** Seconds of padding on each side of a point-in-time map anchor (a single cast). */
export const MAP_POINT_PAD_S = 5;

/**
 * Build per-actor position timelines. With `includeResources: true` WCL flattens one
 * actor's position onto each event, so each event yields one sample.
 */
export function buildActorTimelines(events: WclEvent[], fightStartMs: number): Map<number, ActorTimeline> {
  const byActor = new Map<number, PosSample[]>();
  for (const event of events) {
    const id = posActorId(event);
    if (id == null) continue;
    let samples = byActor.get(id);
    if (!samples) { samples = []; byActor.set(id, samples); }
    samples.push({
      t: (event.timestamp - fightStartMs) / 1000,
      x: event.x! * RAW_TO_YARDS,
      y: event.y! * RAW_TO_YARDS,
      facing: typeof event.facing === 'number' ? event.facing * FACING_TO_RAD : undefined,
      mapID: typeof event.mapID === 'number' ? event.mapID : undefined,
    });
  }
  const out = new Map<number, ActorTimeline>();
  for (const [id, samples] of byActor) {
    samples.sort((a, b) => a.t - b.t);
    out.set(id, { id, samples });
  }
  return out;
}

/** Distinct reference enemies across all parses, for the reference picker. */
export function listReferenceEnemies(positions: EncounterPositions): { gameId: number; name: string; isBoss: boolean }[] {
  const map = new Map<number, { gameId: number; name: string; isBoss: boolean }>();
  for (const parse of positions.parses) {
    for (const enemy of parse.enemies) {
      if (enemy.game_id == null) continue;
      const current = map.get(enemy.game_id);
      if (!current) map.set(enemy.game_id, { gameId: enemy.game_id, name: enemy.name, isBoss: enemy.is_boss });
      else if (enemy.is_boss) current.isBoss = true;
    }
  }
  return [...map.values()].sort((a, b) => (b.isBoss ? 1 : 0) - (a.isBoss ? 1 : 0));
}

export interface LiveReference {
  bossActorId: number | null;
  refActorByGameId: Map<number, number>;
}

/** Map each enemy gameID to its live actor id, then resolve the ingested boss's gameID to this pull's boss actor. */
export function resolveLiveReference(positions: EncounterPositions, enemies: MapEnemyActor[]): LiveReference {
  const refActorByGameId = new Map<number, number>();
  for (const enemy of enemies) if (enemy.gameID != null) refActorByGameId.set(enemy.gameID, enemy.id);
  const bossGameId = listReferenceEnemies(positions).find(enemy => enemy.isBoss)?.gameId;
  const bossActorId = bossGameId != null ? (refActorByGameId.get(bossGameId) ?? null) : null;
  return { bossActorId, refActorByGameId };
}

export interface LiveOverlayInput {
  positions: EncounterPositions;
  events: WclEvent[];
  fightStartMs: number;
  playerId: number;
  enemies: MapEnemyActor[];
}

/** Assemble the live overlay from position-bearing events; null when the player has no samples. */
export function buildLiveOverlay(input: LiveOverlayInput): MapLiveOverlay | null {
  const { positions, events, fightStartMs, playerId, enemies } = input;
  const { bossActorId, refActorByGameId } = resolveLiveReference(positions, enemies);
  const timelines = buildActorTimelines(events, fightStartMs);
  if (!timelines.get(playerId)?.samples.length) return null;
  return { timelines, playerId, bossActorId, refActorByGameId };
}

@Injectable({ providedIn: 'root' })
export class MapFeatureService {
  private readonly source = inject(MAP_DATA_SOURCE);
  // Resolved lazily: only `prepare` needs WCL, so bench-only paths (/pre, tests) never pull in the WCL transport.
  private readonly injector = inject(Injector);

  readonly positions = signal<EncounterPositions | null>(null);
  readonly live = signal<MapLiveOverlay | null>(null);
  /** Transient/permanent bench or overlay failure; a `missing` bench is kept null (it feeds the empty placeholder). */
  readonly error = signal<LoadError | null>(null);
  readonly overlayLoading = signal(false);

  private pendingOverlay: PendingOverlay | null = null;
  /** True once built for the current pull, so a re-open never refetches. */
  private overlayLoaded = false;

  readonly open = signal(false);
  readonly anchorTime = signal(0);
  readonly reference = signal<ReferenceSelector>({ kind: 'boss' });
  /** Seconds of the scrub window before / after `anchorTime`, set per anchor by `openAt`. */
  readonly preS = signal(MAP_POINT_PAD_S);
  readonly postS = signal(MAP_POINT_PAD_S);

  ready(): boolean { return !!this.positions(); }

  /** Load the top-parse bench (the /pre and initial post-raid path). Clears any stale live overlay. */
  async loadBench(spec: string, encounterId: number): Promise<Result<MapData, LoadError>> {
    const result = await this.source.getBench(spec, encounterId);
    this.live.set(null);
    if (result.ok) {
      this.positions.set(result.value);
      this.error.set(null);
    } else {
      if (result.error.kind === 'permanent') logWarn(result.error.id, result.error.context);
      this.positions.set(null);
      this.error.set(result.error.kind === 'missing' ? null : result.error);
    }
    return result;
  }

  /**
   * Prepare the post-raid context: load the bench now, but DEFER the live-overlay fetch (two full
   * position-event streams) until the map first opens, since most analyses never open it. Refreshes
   * immediately if the panel is already open (a live-sync pull mid-watch).
   */
  async prepare(
    reportCode: string, fight: WclFight, playerId: number, spec: string, enemies: MapEnemyActor[],
  ): Promise<void> {
    this.live.set(null);
    this._resetOverlay();
    if (!fight?.encounterID) { this.positions.set(null); this.error.set(null); return; }
    const result = await this.loadBench(spec, fight.encounterID);
    if (!result.ok) return;
    this.pendingOverlay = { reportCode, fight, playerId, positions: result.value, enemies };
    if (this.open()) await this.ensureLiveOverlay();
  }

  openAt(anchor: MapAnchor): void {
    this.anchorTime.set(anchor.timeS);
    this.reference.set(anchor.reference ?? { kind: 'boss' });
    // A window scrubs its exact span (0 before, its length after); a point-in-time cast gets symmetric padding.
    const isWindow = (anchor.windowLengthS ?? 0) > 0;
    this.preS.set(isWindow ? 0 : MAP_POINT_PAD_S);
    this.postS.set(isWindow ? anchor.windowLengthS! : MAP_POINT_PAD_S);
    this.open.set(true);
    // First open triggers the deferred fetch; a no-op once loaded or with no pending pull.
    void this.ensureLiveOverlay();
  }

  close(): void { this.open.set(false); }

  clear(): void {
    this.open.set(false);
    this.positions.set(null);
    this.live.set(null);
    this.error.set(null);
    this._resetOverlay();
  }

  private _resetOverlay(): void {
    this.pendingOverlay = null;
    this.overlayLoaded = false;
    this.overlayLoading.set(false);
  }

  /** Build the live overlay from the deferred `prepare` params, at most once per pull; no-ops when nothing is pending or a fetch is in flight. */
  private async ensureLiveOverlay(): Promise<void> {
    const pending = this.pendingOverlay;
    if (!pending || this.overlayLoaded || this.overlayLoading()) return;
    this.overlayLoading.set(true);
    try {
      const { reportCode, fight, playerId, positions, enemies } = pending;
      const events = await this.fetchLiveEvents(reportCode, fight, playerId);
      this.live.set(buildLiveOverlay({ positions, events, fightStartMs: fight.startTime, playerId, enemies }));
      this.error.set(null);
      this.overlayLoaded = true;
    } catch (cause) {
      // Surface a failed overlay read instead of a silently empty map.
      const result = toLoadError(cause, 'map.overlay');
      logWarn(`MapFeatureService.ensureLiveOverlay ${pending.reportCode}:${pending.fight.id}`, cause);
      this.live.set(null);
      this.error.set(!result.ok && result.error.kind !== 'missing' ? result.error : null);
    } finally {
      this.overlayLoading.set(false);
    }
  }

  /**
   * Fetch position-bearing live events: player casts + enemy casts, both with `includeResources`.
   * The enemy fetch needs `hostilityType: 'Enemies'` because the events query defaults to Friendlies.
   */
  private async fetchLiveEvents(
    reportCode: string, fight: WclFight, playerId: number,
  ): Promise<WclEvent[]> {
    const { id, startTime, endTime } = fight;
    const wclApi = this.injector.get(WclApiService);
    const [playerCasts, enemyCasts] = await Promise.all([
      wclApi.getAllEvents(reportCode, id, 'Casts', startTime, endTime, playerId, true),
      wclApi.getAllEvents(reportCode, id, 'Casts', startTime, endTime, undefined, true, 'Enemies'),
    ]);
    return [...playerCasts, ...enemyCasts];
  }
}
