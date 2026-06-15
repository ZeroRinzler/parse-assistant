/**
 * Pure, framework-free positioning computation.
 *
 * Builds per-actor position timelines (from live WCL events fetched with
 * includeResources, or from ingested top-parse rows) and transforms player
 * positions into a reference actor's local frame, so "behind the boss" is
 * meaningful regardless of how the reference is turned. Also aggregates each
 * top parse's player position/trail relative to a chosen reference (boss or
 * add) for the positioning map's benchmark, and filters by mapID so phases
 * that swap maps never mix coordinate spaces.
 *
 * No Angular dependencies - kept pure so it stays easy to test and could move
 * into a Web Worker later, mirroring `analysis-core.ts`.
 */
import { WclEvent } from '../models/wcl.models';
import { EncounterPositions, ParsePositions, PosRow, ReferenceSelector } from '../models/positioning.models';

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
  /** Player's own facing as a unit vector in the reference frame (forward/right components). */
  headFwd?: number;
  headRight?: number;
}

export interface AbilityInstance {
  /** 0-based index of this cast among casts of the same ability (the cross-pull anchor). */
  castIndex: number;
  /** Fight-relative cast time, seconds. */
  t: number;
  /** Actor that cast it (the natural positioning reference). */
  sourceId: number;
}

export interface RankedAbility {
  abilityGameId: number;
  name: string;
  icon: string;
  instances: AbilityInstance[];
  /** Distinct caster actor ids, most frequent first. */
  sourceIds: number[];
  /** Higher = more worth inspecting for positioning. */
  relevance: number;
  /**
   * Mean spread (yards) of the raid's relative positions around their centroid
   * at cast time, averaged over instances. Lower = players cluster tightly =
   * a "correct spot" exists. Null when it cannot be computed.
   */
  clusterSpread: number | null;
  /** Whether this ability dealt damage to the analysed player. */
  hitPlayer: boolean;
}

const RAW_TO_YARDS = 1 / 100;
const FACING_TO_RAD = 1 / 1000;

function _hasPos(e: WclEvent): boolean {
  return typeof e.x === 'number' && typeof e.y === 'number';
}

/** The actor the event's flattened position describes (resourceActor: 1 = source, 2 = target). */
function _posActorId(e: WclEvent): number | undefined {
  if (!_hasPos(e)) return undefined;
  return e.resourceActor === 2 ? e.targetID : e.sourceID;
}

/** True if any event carries a position - used to distinguish a bug from an API limitation. */
export function hasAnyPosition(events: WclEvent[]): boolean {
  return events.some(_hasPos);
}

/**
 * Build per-actor position timelines from events fetched with
 * `includeResources: true`. WCL flattens one actor's position onto each event
 * (the actor named by `resourceActor`), so each event yields one sample.
 */
export function buildActorTimelines(events: WclEvent[], fStart: number): Map<number, ActorTimeline> {
  const byActor = new Map<number, PosSample[]>();
  for (const e of events) {
    const id = _posActorId(e);
    if (id == null) continue;
    let arr = byActor.get(id);
    if (!arr) { arr = []; byActor.set(id, arr); }
    arr.push({
      t: (e.timestamp - fStart) / 1000,
      x: e.x! * RAW_TO_YARDS,
      y: e.y! * RAW_TO_YARDS,
      facing: typeof e.facing === 'number' ? e.facing * FACING_TO_RAD : undefined,
      mapID: e.mapID,
    });
  }
  const out = new Map<number, ActorTimeline>();
  for (const [id, samples] of byActor) {
    samples.sort((a, b) => a.t - b.t);
    out.set(id, { id, samples });
  }
  return out;
}

/** Shortest signed angular difference b - a, radians, in (-pi, pi]. */
function _angleDelta(a: number, b: number): number {
  let d = (b - a) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d <= -Math.PI) d += 2 * Math.PI;
  return d;
}

/**
 * Interpolated position of an actor at fight-relative time `t`. Returns null
 * when `t` is too far outside the timeline (more than `tolerance` seconds past
 * either end), so we never invent positions for actors that were not present.
 */
export function positionAt(tl: ActorTimeline | undefined, t: number, tolerance = 3): PosSample | null {
  const s = tl?.samples;
  if (!s || !s.length) return null;
  if (t <= s[0].t) return t < s[0].t - tolerance ? null : { ...s[0], t };
  const last = s[s.length - 1];
  if (t >= last.t) return t > last.t + tolerance ? null : { ...last, t };

  // Binary search for the first sample at or after t.
  let lo = 0, hi = s.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (s[mid].t < t) lo = mid + 1; else hi = mid;
  }
  const b = s[lo];
  const a = s[lo - 1];
  const span = b.t - a.t;
  const f = span > 0 ? (t - a.t) / span : 0;
  let facing: number | undefined;
  if (a.facing != null && b.facing != null) {
    facing = a.facing + _angleDelta(a.facing, b.facing) * f;
  } else {
    facing = a.facing ?? b.facing;
  }
  // mapID is categorical, never interpolated - take the nearer sample's value.
  const mapID = f < 0.5 ? a.mapID : b.mapID;
  return { t, x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, facing, mapID };
}

/**
 * WoW's `facing` zero-point does not align with our forward axis; empirically a
 * -90 degree offset puts "behind the boss" below the reference. Calibrated
 * against a known melee log; flip the sign here if left/right ever mirrors.
 */
const FACING_OFFSET_RAD = -Math.PI / 2;

/**
 * Express a player position in the reference's local frame: forward/right
 * relative to the reference's facing, plus distance and clock angle. When the
 * reference has no facing, world axes are used (forward = +y).
 */
export function toReferenceLocal(player: PosSample, ref: PosSample, t = 0): RelPos {
  const dx = player.x - ref.x;
  const dy = player.y - ref.y;
  const f = (ref.facing ?? Math.PI / 2) + FACING_OFFSET_RAD;
  const cos = Math.cos(f), sin = Math.sin(f);
  // Rotate the offset by -f: forward aligns with the reference's facing.
  const fwd = dx * cos + dy * sin;
  const right = dx * sin - dy * cos;
  const dist = Math.hypot(dx, dy);
  const angleDeg = (Math.atan2(right, fwd) * 180) / Math.PI;

  // Player's own facing, expressed in the reference frame. The empirical offset
  // is shared by both facings, so it cancels and only the difference matters.
  let headFwd: number | undefined;
  let headRight: number | undefined;
  if (player.facing != null && ref.facing != null) {
    const d = player.facing - ref.facing;
    headFwd = Math.cos(d);
    headRight = -Math.sin(d);
  }
  return { t, fwd, right, dist, angleDeg, headFwd, headRight };
}

/** Two samples are comparable only if they share a mapID (same phase/map). */
function _sameMap(a: PosSample, b: PosSample): boolean {
  return a.mapID == null || b.mapID == null || a.mapID === b.mapID;
}

/** Mean distance of points to their centroid (a simple spread metric), yards. */
function _spread(points: Array<{ fwd: number; right: number }>): number | null {
  if (points.length < 2) return null;
  const cx = points.reduce((s, p) => s + p.fwd, 0) / points.length;
  const cy = points.reduce((s, p) => s + p.right, 0) / points.length;
  const d = points.reduce((s, p) => s + Math.hypot(p.fwd - cx, p.right - cy), 0) / points.length;
  return d;
}

/**
 * Relative positions of a set of actors to a reference actor at a given time.
 * Skips actors with no position near that time.
 */
export function relativePositionsAt(
  actorIds: number[],
  timelines: Map<number, ActorTimeline>,
  refId: number,
  t: number,
): Map<number, RelPos> {
  const out = new Map<number, RelPos>();
  const ref = positionAt(timelines.get(refId), t);
  if (!ref) return out;
  for (const id of actorIds) {
    if (id === refId) continue;
    const p = positionAt(timelines.get(id), t);
    if (p && _sameMap(p, ref)) out.set(id, toReferenceLocal(p, ref, t));
  }
  return out;
}

/**
 * A movement trail: an actor's relative position sampled across the window
 * [tCast - pre, tCast + post]. This is what surfaces pre-positioning.
 */
export function buildTrail(
  actorId: number,
  refId: number,
  timelines: Map<number, ActorTimeline>,
  tCast: number,
  pre: number,
  post: number,
  step: number,
): RelPos[] {
  const trail: RelPos[] = [];
  const refTl = timelines.get(refId);
  const actorTl = timelines.get(actorId);
  for (let t = tCast - pre; t <= tCast + post + 1e-6; t += step) {
    const ref = positionAt(refTl, t);
    const p = positionAt(actorTl, t);
    if (ref && p && _sameMap(p, ref)) trail.push(toReferenceLocal(p, ref, t));
  }
  return trail;
}

interface RankInput {
  /** All casts in the fight (any source), with positions where available. */
  casts: WclEvent[];
  fStart: number;
  timelines: Map<number, ActorTimeline>;
  /** Friendly (raid) actor ids - used both as "enemy = not friendly" and as the cluster cohort. */
  friendlyIds: Set<number>;
  abilityMap: Record<number, { name: string; icon: string }>;
  /** Ability ids that dealt damage to the analysed player. */
  hitPlayerAbilityIds: Set<number>;
  /** Cap how many instances per ability we sample for the spread metric (perf). */
  maxInstancesForSpread?: number;
}

/**
 * Group casts by ability and rank them by positioning relevance: abilities that
 * hit the player, where the raid clusters tightly (a correct spot exists), rank
 * highest. Only enemy-cast abilities are considered (the player does not
 * position relative to friendly casts).
 */
export function rankAbilities(input: RankInput): RankedAbility[] {
  const { casts, fStart, timelines, friendlyIds, abilityMap, hitPlayerAbilityIds } = input;
  const maxForSpread = input.maxInstancesForSpread ?? 6;

  const byAbility = new Map<number, { t: number; sourceId: number }[]>();
  for (const e of casts) {
    if (e.type !== 'cast' && e.type !== 'begincast') continue;
    const src = e.sourceID;
    if (src == null || friendlyIds.has(src)) continue; // enemy casts only
    const aid = e.abilityGameID;
    if (!aid) continue;
    let arr = byAbility.get(aid);
    if (!arr) { arr = []; byAbility.set(aid, arr); }
    arr.push({ t: (e.timestamp - fStart) / 1000, sourceId: src });
  }

  const cohort = [...friendlyIds];
  const ranked: RankedAbility[] = [];
  for (const [aid, raw] of byAbility) {
    raw.sort((a, b) => a.t - b.t);
    const instances: AbilityInstance[] = raw.map((r, i) => ({ castIndex: i, t: r.t, sourceId: r.sourceId }));

    // Most frequent casters first.
    const counts = new Map<number, number>();
    for (const r of raw) counts.set(r.sourceId, (counts.get(r.sourceId) ?? 0) + 1);
    const sourceIds = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);

    // Cluster spread: average over a sample of instances of how tightly the
    // raid bunches relative to the caster at cast time.
    const sampleStride = Math.max(1, Math.floor(instances.length / maxForSpread));
    const spreads: number[] = [];
    for (let i = 0; i < instances.length; i += sampleStride) {
      const inst = instances[i];
      const rel = relativePositionsAt(cohort, timelines, inst.sourceId, inst.t);
      const sp = _spread([...rel.values()]);
      if (sp != null) spreads.push(sp);
    }
    const clusterSpread = spreads.length ? spreads.reduce((s, v) => s + v, 0) / spreads.length : null;

    const hitPlayer = hitPlayerAbilityIds.has(aid);
    // Relevance: hitting the player dominates; then tighter clusters (a clear
    // correct spot) and having enough instances to be a real, repeated mechanic.
    let relevance = 0;
    if (hitPlayer) relevance += 1000;
    if (clusterSpread != null) relevance += Math.max(0, 60 - clusterSpread);
    relevance += Math.min(instances.length, 10);

    const meta = abilityMap[aid] ?? { name: `Spell ${aid}`, icon: '' };
    ranked.push({
      abilityGameId: aid,
      name: meta.name || `Spell ${aid}`,
      icon: meta.icon || '',
      instances,
      sourceIds,
      relevance,
      clusterSpread,
      hitPlayer,
    });
  }

  ranked.sort((a, b) => b.relevance - a.relevance);
  return ranked;
}

// ── Ingested top-parse positions ─────────────────────────────────────────────

/** Build an actor timeline from stored position rows (scaling raw units to yards/radians). */
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

function _refRows(parse: ParsePositions, selector: ReferenceSelector): PosRow[] | null {
  if (selector.kind === 'boss') {
    const boss = parse.enemies.find(e => e.is_boss) ?? parse.enemies[0];
    return boss?.samples ?? null;
  }
  return parse.enemies.find(e => e.game_id === selector.gameId)?.samples ?? null;
}

/** Distinct reference enemies across all parses, for the map's reference picker. */
export function listReferenceEnemies(positions: EncounterPositions): Array<{ gameId: number; name: string; isBoss: boolean }> {
  const map = new Map<number, { gameId: number; name: string; isBoss: boolean }>();
  for (const parse of positions.parses) {
    for (const e of parse.enemies) {
      if (e.game_id == null) continue;
      const cur = map.get(e.game_id);
      if (!cur) map.set(e.game_id, { gameId: e.game_id, name: e.name, isBoss: e.is_boss });
      else if (e.is_boss) cur.isBoss = true;
    }
  }
  return [...map.values()].sort((a, b) => (b.isBoss ? 1 : 0) - (a.isBoss ? 1 : 0));
}

/** Each top parse's player position relative to the chosen reference at time `t`. */
export function topParsePoints(positions: EncounterPositions, selector: ReferenceSelector, t: number): RelPos[] {
  const out: RelPos[] = [];
  for (const parse of positions.parses) {
    const rRows = _refRows(parse, selector);
    if (!rRows) continue;
    const ref = positionAt(rowsToTimeline(-2, rRows), t);
    const p = positionAt(rowsToTimeline(-1, parse.player), t);
    if (ref && p && _sameMap(p, ref)) out.push(toReferenceLocal(p, ref, t));
  }
  return out;
}

/** Each top parse's player trail relative to the chosen reference across the window. */
export function topParseTrails(
  positions: EncounterPositions,
  selector: ReferenceSelector,
  t: number,
  pre: number,
  post: number,
  step: number,
): RelPos[][] {
  const trails: RelPos[][] = [];
  for (const parse of positions.parses) {
    const rRows = _refRows(parse, selector);
    if (!rRows) continue;
    const refTl = rowsToTimeline(-2, rRows);
    const playerTl = rowsToTimeline(-1, parse.player);
    const trail: RelPos[] = [];
    for (let tt = t - pre; tt <= t + post + 1e-6; tt += step) {
      const ref = positionAt(refTl, tt);
      const p = positionAt(playerTl, tt);
      if (ref && p && _sameMap(p, ref)) trail.push(toReferenceLocal(p, ref, tt));
    }
    if (trail.length) trails.push(trail);
  }
  return trails;
}
