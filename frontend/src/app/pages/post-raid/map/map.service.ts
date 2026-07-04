/**
 * Map slice runtime shell + its pure positioning functions, colocated.
 *
 * `MapFeatureService` is the imperative shell (the components inject only it). It
 * owns the positioning-panel state (open / anchorTime / reference
 * plus the loaded bench and the optional live overlay), reads the prepared bench via the
 * swappable `MAP_DATA_SOURCE`, and builds the live overlay from `WclApiService`
 * position events. Every calculated field is its own small, exported,
 * individually-tested pure function below - no separate vm file.
 *
 * Per the slice self-containment rule it imports ONLY the two API services (here
 * via `MAP_DATA_SOURCE` + `WclApiService`), models, `logWarn`, and the slice-local
 * `map-positions` projection - never `positioning-core`, `map-context`, or any other
 * domain service. The positioning math (`buildActorTimelines`, `listReferenceEnemies`,
 * the facing offset) is PORTED here as pure fns rather than imported.
 */
import { Injectable, Injector, inject, signal } from '@angular/core';
import { WclApiService } from '../../../core/services/wcl-api';
import { WclEvent, WclFight } from '../../../core/models/wcl.models';
import { EncounterPositions, ReferenceSelector } from '../../../core/models/positioning.models';
import { logWarn } from '../../../core/log';
import { posActorId } from './map-positions';
import { MAP_DATA_SOURCE, MapData } from './map-data-source';

/**
 * WoW's `facing` zero-point does not align with our forward axis; empirically a
 * -90 degree offset puts "behind the boss" below the reference. Ported verbatim
 * from `positioning-core` so the slice owns its own copy.
 */
export const FACING_OFFSET_RAD = -Math.PI / 2;

const RAW_TO_YARDS = 1 / 100;
const FACING_TO_RAD = 1 / 1000;

/** One position sample for an actor, fight-relative time in seconds, coords in yards. */
export interface PosSample {
  t: number;
  x: number;
  y: number;
  facing?: number;
  /** Map/phase the actor was on; positions are only comparable within one mapID. */
  mapID?: number;
}

export interface ActorTimeline {
  id: number;
  samples: PosSample[];
}

/**
 * Live player overlay: live-pull timelines plus how to resolve the reference actor
 * per selector. Same shape the legacy `PositioningMapComponent` consumed.
 */
export interface MapLiveOverlay {
  timelines: Map<number, ActorTimeline>;
  playerId: number;
  /** Live boss actor id (matched to the ingested boss). */
  bossActorId: number | null;
  /** gameID -> live actor id, so a chosen enemy reference maps to this pull's actor. */
  refActorByGameId: Map<number, number>;
}

/** A friendly/enemy actor id + gameID, supplied by the page from the report master data. */
export interface MapEnemyActor { id: number; name: string; gameID: number; }

/**
 * Everything the deferred live-overlay fetch needs, captured by `prepare` and consumed the
 * first time the map panel opens. Holding these lets the expensive position-event fetch wait
 * until the user actually opens the map (most analyses never do).
 */
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
  /** Optional reference override; defaults to the boss. */
  reference?: ReferenceSelector;
}

/* ----------------------------- pure functions ----------------------------- */

/**
 * Build per-actor position timelines from events fetched with
 * `includeResources: true`. WCL flattens one actor's position onto each event
 * (the actor named by `resourceActor`), so each event yields one sample. Ported
 * from `positioning-core.buildActorTimelines`.
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

/**
 * Distinct reference enemies across all parses, for the map's reference picker.
 * Ported from `positioning-core.listReferenceEnemies`.
 */
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

/** The live actor that stands in for the ingested boss, plus the gameID -> live-actor-id map. */
export interface LiveReference {
  bossActorId: number | null;
  refActorByGameId: Map<number, number>;
}

/**
 * Resolve the live pull's reference actors from the ingested bench: map each
 * enemy's gameID to its live actor id, then look up the ingested boss's gameID to
 * find this pull's boss actor. Shared by the overlay builder and the event fetch so
 * the derivation lives in one place. Pure.
 */
export function resolveLiveReference(positions: EncounterPositions, enemies: MapEnemyActor[]): LiveReference {
  const refActorByGameId = new Map<number, number>();
  for (const enemy of enemies) if (enemy.gameID != null) refActorByGameId.set(enemy.gameID, enemy.id);
  const bossGameId = listReferenceEnemies(positions).find(enemy => enemy.isBoss)?.gameId;
  const bossActorId = bossGameId != null ? (refActorByGameId.get(bossGameId) ?? null) : null;
  return { bossActorId, refActorByGameId };
}

/** Inputs for assembling the live player overlay from already-fetched position events. */
export interface LiveOverlayInput {
  positions: EncounterPositions;
  events: WclEvent[];
  fightStartMs: number;
  playerId: number;
  enemies: MapEnemyActor[];
}

/**
 * Assemble the live overlay from already-fetched, position-bearing live events:
 * per-actor timelines plus the live actor id for the ingested boss and a gameID
 * -> live-actor-id map for enemy references. Null when the player has no samples.
 * Reproduces the core of the legacy `MapContextService._buildLiveOverlay` minus
 * the fetching, so it stays pure and testable.
 */
export function buildLiveOverlay(input: LiveOverlayInput): MapLiveOverlay | null {
  const { positions, events, fightStartMs, playerId, enemies } = input;
  const { bossActorId, refActorByGameId } = resolveLiveReference(positions, enemies);
  const timelines = buildActorTimelines(events, fightStartMs);
  if (!timelines.get(playerId)?.samples.length) return null;
  return { timelines, playerId, bossActorId, refActorByGameId };
}

/* ----------------------------- feature service ---------------------------- */

@Injectable({ providedIn: 'root' })
export class MapFeatureService {
  private readonly source = inject(MAP_DATA_SOURCE);
  // Resolved lazily: only `prepare` (the post-raid live overlay) needs WCL, so the
  // bench-only paths (/pre, tests) never pull in the WCL transport / Apollo.
  private readonly injector = inject(Injector);

  /** Loaded top-parse bench for the current encounter (null until loaded / on /pre with no file). */
  readonly positions = signal<EncounterPositions | null>(null);
  /** Live player overlay; null on pages with no pull (e.g. /pre) or before a pull loads. */
  readonly live = signal<MapLiveOverlay | null>(null);
  /** True while the deferred live-overlay event fetch is in flight (drives the panel spinner). */
  readonly overlayLoading = signal(false);

  /** Params for the deferred overlay fetch (set by `prepare`, consumed on first open). */
  private pendingOverlay: PendingOverlay | null = null;
  /** True once the overlay has been built for the current pull, so a re-open never refetches. */
  private overlayLoaded = false;

  /** Panel state - ported from the global `PositioningPanelService`. */
  readonly open = signal(false);
  readonly anchorTime = signal(0);
  readonly reference = signal<ReferenceSelector>({ kind: 'boss' });

  /** True once top-parse positions are available, so the page can show map buttons. */
  ready(): boolean { return !!this.positions(); }

  /**
   * Load the top-parse bench for an encounter (bench-only path - /pre and the
   * initial post-raid load). Clears any stale live overlay.
   */
  async loadBench(spec: string, encounterId: number): Promise<MapData | null> {
    const data = await this.source.getBench(spec, encounterId);
    this.positions.set(data);
    this.live.set(null);
    return data;
  }

  /**
   * Prepare the post-raid context: load the top-parse bench (so the map buttons can light
   * up) but DEFER the live-overlay fetch. Building the overlay costs two full position-
   * event streams (player casts, every enemy cast), and most analyses never
   * open the map - so the params are captured and the fetch waits until the panel first
   * opens (see `ensureLiveOverlay`). If the panel is already open (a live-sync pull while
   * the user is watching the map), the overlay refreshes immediately.
   */
  async prepare(
    reportCode: string, fight: WclFight, playerId: number, spec: string, enemies: MapEnemyActor[],
  ): Promise<void> {
    this.live.set(null);
    this._resetOverlay();
    if (!fight?.encounterID) { this.positions.set(null); return; }
    try {
      const positions = await this.loadBench(spec, fight.encounterID);
      if (!positions) return;
      this.pendingOverlay = { reportCode, fight, playerId, positions, enemies };
      if (this.open()) await this.ensureLiveOverlay();
    } catch (err) {
      logWarn(`MapFeatureService.prepare ${reportCode}:${fight?.id}`, err);
      this.live.set(null);
    }
  }

  /** Open the map at an anchor emitted by another feature card. */
  openAt(anchor: MapAnchor): void {
    this.anchorTime.set(anchor.timeS);
    this.reference.set(anchor.reference ?? { kind: 'boss' });
    this.open.set(true);
    // First open triggers the deferred overlay fetch; a no-op once loaded, or when there is
    // no pending pull (bench-only /pre).
    void this.ensureLiveOverlay();
  }

  close(): void { this.open.set(false); }

  /** Drop all context (e.g. when starting a new analysis). */
  clear(): void {
    this.open.set(false);
    this.positions.set(null);
    this.live.set(null);
    this._resetOverlay();
  }

  /** Forget any deferred overlay so a new pull (or a cleared map) starts cold. */
  private _resetOverlay(): void {
    this.pendingOverlay = null;
    this.overlayLoaded = false;
    this.overlayLoading.set(false);
  }

  /**
   * Build the live overlay from the deferred `prepare` params, on demand. Idempotent and
   * guarded: it fetches at most once per pull (a re-open is free) and no-ops when there is
   * nothing pending (bench-only pages) or a fetch is already in flight.
   */
  private async ensureLiveOverlay(): Promise<void> {
    const pending = this.pendingOverlay;
    if (!pending || this.overlayLoaded || this.overlayLoading()) return;
    this.overlayLoading.set(true);
    try {
      const { reportCode, fight, playerId, positions, enemies } = pending;
      const events = await this.fetchLiveEvents(reportCode, fight, playerId);
      this.live.set(buildLiveOverlay({ positions, events, fightStartMs: fight.startTime, playerId, enemies }));
      this.overlayLoaded = true;
    } catch (err) {
      logWarn(`MapFeatureService.ensureLiveOverlay ${pending.reportCode}:${pending.fight.id}`, err);
      this.live.set(null);
    } finally {
      this.overlayLoading.set(false);
    }
  }

  /**
   * Fetch the position-bearing live events the overlay needs: friendly player casts + enemy
   * casts, both with `includeResources`. The enemy fetch passes `hostilityType: 'Enemies'`
   * (the events query defaults to Friendlies, so an enemy-side fetch without it returns
   * nothing). The boss and add trails come from the enemy casts, as in
   * `MapTransformService.fetchPositionEvents`.
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
