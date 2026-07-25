/**
 * Pure drawing-geometry helpers for the map canvas, colocated with the map slice.
 *
 * These are ported from `positioning-core` (positionAt / toReferenceLocal /
 * trails / top-parse aggregation) so the map components import no domain service -
 * only this slice-local module + `MapFeatureService`. Coordinates here are already
 * scaled to yards / radians (the bench rows are scaled by `rowsToTimeline`).
 */
import { EncounterPositions, ParsePositions, PlayerPosRow, PosRow, ReferenceSelector } from '../../../core/models/positioning.models';
import { ActorTimeline, PosSample, FACING_OFFSET_RAD } from './map.service';

const RAW_TO_YARDS = 1 / 100;
const FACING_TO_RAD = 1 / 1000;

/** A player position expressed in a reference actor's local frame. */
export interface RelPos {
  t: number;
  /** Yards in front of (+) / behind (-) the reference's facing. */
  fwd: number;
  /** Yards to the right (+) / left (-) of the reference's facing. */
  right: number;
  /** Distance from the reference, yards. */
  dist: number;
  /** Clock angle around the reference, degrees (0 = directly in front). */
  angleDeg: number;
  /** The map this relative frame sits on; a trail draws no segment where it changes. */
  mapID?: number;
}

/** Shortest signed angular difference b - a, radians, in (-pi, pi]. */
function angleDelta(a: number, b: number): number {
  let delta = (b - a) % (2 * Math.PI);
  if (delta > Math.PI) delta -= 2 * Math.PI;
  if (delta <= -Math.PI) delta += 2 * Math.PI;
  return delta;
}

/** Two samples are comparable only if they share a mapID (same phase/map). */
function sameMap(a: PosSample, b: PosSample): boolean {
  return a.mapID == null || b.mapID == null || a.mapID === b.mapID;
}

/**
 * Interpolated position of an actor at fight-relative time `t`. Returns null when
 * `t` is more than `tolerance` seconds past either end of the timeline.
 */
export function positionAt(timeline: ActorTimeline | undefined, t: number, tolerance = 3): PosSample | null {
  const samples = timeline?.samples;
  if (!samples || !samples.length) return null;
  if (t <= samples[0].t) return t < samples[0].t - tolerance ? null : { ...samples[0], t };
  const last = samples[samples.length - 1];
  if (t >= last.t) return t > last.t + tolerance ? null : { ...last, t };

  let lo = 0, hi = samples.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].t < t) lo = mid + 1; else hi = mid;
  }
  const after = samples[lo];
  const before = samples[lo - 1];
  const span = after.t - before.t;
  const fraction = span > 0 ? (t - before.t) / span : 0;
  // Coordinates only compare within one mapID, so a bracket straddling a map swap snaps to the nearer sample.
  if (before.mapID !== after.mapID) return { ...(fraction < 0.5 ? before : after), t };
  let facing: number | undefined;
  if (before.facing != null && after.facing != null) {
    facing = before.facing + angleDelta(before.facing, after.facing) * fraction;
  } else {
    facing = before.facing ?? after.facing;
  }
  return {
    t,
    x: before.x + (after.x - before.x) * fraction,
    y: before.y + (after.y - before.y) * fraction,
    facing,
    mapID: before.mapID,
  };
}

/**
 * Express a player position in the reference's local frame: forward/right relative
 * to the reference's facing, plus distance and clock angle. When the reference has
 * no facing, world axes are used (forward = +y).
 */
export function toReferenceLocal(player: PosSample, ref: PosSample, t = 0): RelPos {
  const dx = player.x - ref.x;
  const dy = player.y - ref.y;
  const facing = (ref.facing ?? Math.PI / 2) + FACING_OFFSET_RAD;
  const cos = Math.cos(facing), sin = Math.sin(facing);
  const fwd = dx * cos + dy * sin;
  const right = dx * sin - dy * cos;
  const dist = Math.hypot(dx, dy);
  const angleDeg = (Math.atan2(right, fwd) * 180) / Math.PI;
  return { t, fwd, right, dist, angleDeg, mapID: player.mapID };
}

/** Build an enemy timeline from stored position rows (scaling raw units to yards/radians). */
export function rowsToTimeline(id: number, rows: PosRow[]): ActorTimeline {
  const samples: PosSample[] = rows.map(([t, x, y, facing, mapID]) => ({
    t,
    x: x * RAW_TO_YARDS,
    y: y * RAW_TO_YARDS,
    facing: facing == null ? undefined : facing * FACING_TO_RAD,
    mapID: mapID == null ? undefined : mapID,
  }));
  return { id, samples };
}

/** Build the player timeline from stored [t, x, y, mapID] rows (player rows store no facing). */
export function playerRowsToTimeline(id: number, rows: PlayerPosRow[]): ActorTimeline {
  const samples: PosSample[] = rows.map(([t, x, y, mapID]) => ({
    t,
    x: x * RAW_TO_YARDS,
    y: y * RAW_TO_YARDS,
    mapID: mapID == null ? undefined : mapID,
  }));
  return { id, samples };
}

/** Reference enemy rows for a parse per the selector (boss = is_boss, else gameId). */
function refRows(parse: ParsePositions, selector: ReferenceSelector): PosRow[] | null {
  if (selector.kind === 'boss') {
    const boss = parse.enemies.find(enemy => enemy.is_boss) ?? parse.enemies[0];
    return boss?.samples ?? null;
  }
  return parse.enemies.find(enemy => enemy.game_id === selector.gameId)?.samples ?? null;
}

/**
 * One top parse's player + chosen-reference timelines, already scaled to yards/radians.
 * Building these is the expensive part (it maps every stored row into a sample object), and
 * it depends only on the bench + selector, never on the scrubbed time - so the map canvas
 * builds them once per positions/selector (`buildParseTimelines`) and reuses them across every
 * playback frame.
 */
export interface ParseTimelines { player: ActorTimeline; ref: ActorTimeline; }

/** Scale each parse's player + reference rows into timelines once, for the chosen reference. */
export function buildParseTimelines(positions: EncounterPositions, selector: ReferenceSelector): ParseTimelines[] {
  const out: ParseTimelines[] = [];
  for (const parse of positions.parses) {
    const rows = refRows(parse, selector);
    if (!rows) continue;
    out.push({ player: playerRowsToTimeline(-1, parse.player), ref: rowsToTimeline(-2, rows) });
  }
  return out;
}

/** Each parse's player position relative to the reference at `t`, from prebuilt timelines. */
export function parsePointsAt(timelines: ParseTimelines[], t: number): RelPos[] {
  const out: RelPos[] = [];
  for (const { player: playerTl, ref: refTl } of timelines) {
    const ref = positionAt(refTl, t);
    const player = positionAt(playerTl, t);
    if (ref && player && sameMap(player, ref)) out.push(toReferenceLocal(player, ref, t));
  }
  return out;
}

/** Each parse's player trail across the window, from prebuilt timelines. */
export function parseTrailsOf(
  timelines: ParseTimelines[], t: number, pre: number, post: number, step: number,
): RelPos[][] {
  const trails: RelPos[][] = [];
  for (const { player: playerTl, ref: refTl } of timelines) {
    const trail: RelPos[] = [];
    for (let tt = t - pre; tt <= t + post + 1e-6; tt += step) {
      const ref = positionAt(refTl, tt);
      const player = positionAt(playerTl, tt);
      if (ref && player && sameMap(player, ref)) trail.push(toReferenceLocal(player, ref, tt));
    }
    if (trail.length) trails.push(trail);
  }
  return trails;
}

/**
 * An actor's relative trail across [tCast - pre, tCast + post] in live (already
 * yard-scaled) timelines - the player's own movement overlay.
 */
export function buildTrail(
  actorId: number, refId: number, timelines: Map<number, ActorTimeline>,
  tCast: number, pre: number, post: number, step: number,
): RelPos[] {
  const trail: RelPos[] = [];
  const refTl = timelines.get(refId);
  const actorTl = timelines.get(actorId);
  for (let t = tCast - pre; t <= tCast + post + 1e-6; t += step) {
    const ref = positionAt(refTl, t);
    const player = positionAt(actorTl, t);
    if (ref && player && sameMap(player, ref)) trail.push(toReferenceLocal(player, ref, t));
  }
  return trail;
}
