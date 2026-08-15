/** The positioning math is owned here as pure fns rather than shared, so the slice stays self-contained. */
import { Injectable, Injector, PendingTasks, computed, inject, signal } from '@angular/core';
import { WclApiService } from '../../../core/services/wcl-api';
import { WclEvent, WclFight } from '../../../core/models/wcl.models';
import { EncounterPositions, ReferenceSelector } from '../../../core/models/positioning.models';
import { logWarn } from '../../../core/log';
import { Result, LoadError, permanent } from '../../../core/result';
import { toLoadError } from '../../../core/http-load-error';
import { TimedEvent, withRelativeS } from '../../../shared/analysis/wcl-projections';
import { posActorId } from './map-positions';
import { MAP_DATA_SOURCE, MapData } from './map-data-source';

/** WoW's `facing` zero-point does not align with our forward axis; empirically a -90 degree offset puts "behind the boss" below the reference. */
export const FACING_OFFSET_RAD = -Math.PI / 2;

const RAW_TO_YARDS = 1 / 100;
const FACING_TO_RAD = 1 / 1000;

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

export interface MapLiveOverlay {
  timelines: Map<number, ActorTimeline>;
  playerId: number;
  bossActorId: number | null;
  /** gameID -> live actor id, so a chosen enemy reference maps to this pull's actor. */
  refActorByGameId: Map<number, number>;
}

export interface MapEnemyActor { id: number; name: string; gameID: number; }

interface PendingOverlay {
  reportCode: string;
  fight: WclFight;
  playerId: number;
  positions: EncounterPositions;
  enemies: MapEnemyActor[];
  /** The `prepare` sequence that captured this; a deferred overlay from a superseded pull is dropped. */
  seq: number;
}

export interface MapAnchor {
  timeS: number;
  /** A window plays its exact span (`timeS` to `timeS + windowLengthS`); a point-in-time cast omits it (0/undefined) and gets pre/post padding instead. */
  windowLengthS?: number;
  /** Optional reference override; defaults to the boss. */
  reference?: ReferenceSelector;
}

export const MAP_POINT_PAD_S = 5;

/** With `includeResources: true` WCL flattens one actor's position onto each event, so each event yields one sample. */
export function buildActorTimelines(events: TimedEvent[]): Map<number, ActorTimeline> {
  const byActor = new Map<number, PosSample[]>();
  for (const event of events) {
    const id = posActorId(event);
    if (id == null || event.x == null || event.y == null) continue;
    let samples = byActor.get(id);
    if (!samples) { samples = []; byActor.set(id, samples); }
    samples.push({
      t: event.atS,
      x: event.x * RAW_TO_YARDS,
      y: event.y * RAW_TO_YARDS,
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

export function resolveLiveReference(positions: EncounterPositions, enemies: MapEnemyActor[]): LiveReference {
  const refActorByGameId = new Map<number, number>();
  for (const enemy of enemies) refActorByGameId.set(enemy.gameID, enemy.id);
  const bossGameId = listReferenceEnemies(positions).find(enemy => enemy.isBoss)?.gameId;
  const bossActorId = bossGameId != null ? (refActorByGameId.get(bossGameId) ?? null) : null;
  return { bossActorId, refActorByGameId };
}

export interface LiveOverlayInput {
  positions: EncounterPositions;
  events: TimedEvent[];
  playerId: number;
  enemies: MapEnemyActor[];
}

export function buildLiveOverlay(input: LiveOverlayInput): MapLiveOverlay | null {
  const { positions, events, playerId, enemies } = input;
  const { bossActorId, refActorByGameId } = resolveLiveReference(positions, enemies);
  const timelines = buildActorTimelines(events);
  if (!timelines.get(playerId)?.samples.length) return null;
  return { timelines, playerId, bossActorId, refActorByGameId };
}

@Injectable({ providedIn: 'root' })
export class MapFeatureService {
  private readonly source = inject(MAP_DATA_SOURCE);
  // Resolved lazily: only `prepare` needs WCL, so bench-only paths (/pre, tests) never pull in the WCL transport.
  private readonly injector = inject(Injector);
  private readonly pending = inject(PendingTasks);

  readonly positions = signal<EncounterPositions | null>(null);
  readonly live = signal<MapLiveOverlay | null>(null);
  /** Transient/permanent bench or overlay failure; a `missing` bench is kept null (it feeds the empty placeholder). */
  readonly error = signal<LoadError | null>(null);
  readonly overlayLoading = signal(false);

  private pendingOverlay: PendingOverlay | null = null;
  /** True once built for the current pull, so a re-open never refetches. */
  private overlayLoaded = false;
  /** Bumped on every `prepare`; a slow bench/overlay load checks it so a stale selection never wins. */
  private prepareSeq = 0;

  readonly open = signal(false);
  readonly anchorTime = signal(0);
  readonly reference = signal<ReferenceSelector>({ kind: 'boss' });
  /** Seconds of the scrub window before / after `anchorTime`, set per anchor by `openAt`. */
  readonly preS = signal(MAP_POINT_PAD_S);
  readonly postS = signal(MAP_POINT_PAD_S);

  readonly ready = computed(() => !!this.positions());

  /** Load the top-parse bench (the /pre and initial post-raid path). Clears any stale live overlay. */
  async loadBench(spec: string, encounterId: number): Promise<Result<MapData>> {
    const result = await this.source.getBench(spec, encounterId);
    this._applyBench(result);
    return result;
  }

  /** Push a bench result to the `positions`/`error` signals and clear any stale live overlay. */
  private _applyBench(result: Result<MapData>): void {
    this.live.set(null);
    if (result.ok) {
      this.positions.set(result.value);
      this.error.set(null);
    } else {
      if (result.error.kind === 'permanent') logWarn(result.error.id, result.error.context);
      this.positions.set(null);
      this.error.set(result.error.kind === 'missing' ? null : result.error);
    }
  }

  /** Defers the live-overlay fetch (two full position-event streams) until the map first opens, since most analyses never open it. */
  async prepare(
    reportCode: string, fight: WclFight, playerId: number, spec: string, enemies: MapEnemyActor[],
  ): Promise<void> {
    const seq = ++this.prepareSeq;
    this.live.set(null);
    this._resetOverlay();
    if (!fight.encounterID) { this.positions.set(null); this.error.set(null); return; }
    const result = await this.source.getBench(spec, fight.encounterID);
    if (seq !== this.prepareSeq) return; // a newer prepare superseded this selection
    this._applyBench(result);
    if (!result.ok) return;
    this.pendingOverlay = { reportCode, fight, playerId, positions: result.value, enemies, seq };
    if (this.open()) await this.ensureLiveOverlay();
  }

  openAt(anchor: MapAnchor): void {
    this.anchorTime.set(anchor.timeS);
    this.reference.set(anchor.reference ?? { kind: 'boss' });
    // A window scrubs its exact span (0 before, its length after); a point-in-time cast gets symmetric padding.
    const windowLengthS = anchor.windowLengthS ?? 0;
    const isWindow = windowLengthS > 0;
    this.preS.set(isWindow ? 0 : MAP_POINT_PAD_S);
    this.postS.set(isWindow ? windowLengthS : MAP_POINT_PAD_S);
    this.open.set(true);
    // First open triggers the deferred fetch, reported as pending work so a caller can await it; a no-op once loaded or with no pending pull.
    const done = this.pending.add();
    void this.ensureLiveOverlay().finally(done);
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

  private async ensureLiveOverlay(): Promise<void> {
    const pending = this.pendingOverlay;
    if (!pending || this.overlayLoaded || this.overlayLoading()) return;
    this.overlayLoading.set(true);
    try {
      const { reportCode, fight, playerId, positions, enemies } = pending;
      const events = await this.fetchLiveEvents(reportCode, fight, playerId);
      if (pending.seq !== this.prepareSeq) return; // a newer prepare superseded this deferred overlay
      const overlay = buildLiveOverlay({ positions, events: withRelativeS(events, fight.startTime), playerId, enemies });
      this.live.set(overlay);
      if (overlay) {
        this.error.set(null);
      } else {
        // The overlay loaded with no position samples for the player: surface as permanent, not a still-loading map.
        const failure = permanent('No position data for you in this pull.', 'map.no-player-positions');
        if (!failure.ok && failure.error.kind === 'permanent') {
          logWarn(failure.error.id, failure.error.context);
          this.error.set(failure.error);
        }
      }
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

  /** The enemy fetch needs `hostilityType: 'Enemies'` because the events query defaults to Friendlies. */
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
