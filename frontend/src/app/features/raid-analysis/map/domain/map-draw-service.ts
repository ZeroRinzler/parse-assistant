import { Injectable } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class MapDrawService {
  /** The actor a resource-bearing event's flattened position describes (1 = source, 2 = target). */
  posActorId(event: WclEvent): number | null {
    if (typeof event.x !== 'number' || typeof event.y !== 'number') return null;
    return event.resourceActor === 2 ? event.targetID ?? null : event.sourceID ?? null;
  }

  /** Shortest signed angular difference b - a, radians, in (-pi, pi]. */
  private angleDelta(a: number, b: number): number {
    let delta = (b - a) % (2 * Math.PI);
    if (delta > Math.PI) delta -= 2 * Math.PI;
    if (delta <= -Math.PI) delta += 2 * Math.PI;
    return delta;
  }

  /** Two samples are comparable only if they share a mapID (same phase/map). */
  private sameMap(a: PosSample, b: PosSample): boolean {
    return a.mapID == null || b.mapID == null || a.mapID === b.mapID;
  }

  private interpolateBracket(before: PosSample, after: PosSample, t: number): PosSample {
    const span = after.t - before.t;
    const fraction = span > 0 ? (t - before.t) / span : 0;
    // Coordinates only compare within one mapID, so a bracket straddling a map swap snaps to the nearer sample.
    if (before.mapID !== after.mapID) return { ...(fraction < 0.5 ? before : after), t };
    let facing: number | undefined;
    if (before.facing != null && after.facing != null) {
      facing = before.facing + this.angleDelta(before.facing, after.facing) * fraction;
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

  /** Returns null when `t` is more than `tolerance` seconds past either end of the timeline. */
  positionAt(timeline: ActorTimeline | undefined, t: number, tolerance = 3): PosSample | null {
    const samples = timeline?.samples ?? [];
    const first = samples[0];
    if (!first) return null;
    if (t <= first.t) return t < first.t - tolerance ? null : { ...first, t };

    // `left` lands on the first sample at or past `t`, so its predecessor is the bracket's lower bound.
    const index = sampleBisector.left(samples, t);
    const before = samples[index - 1] ?? first;
    const after = samples[index];
    if (!after) return t > before.t + tolerance ? null : { ...before, t };
    return this.interpolateBracket(before, after, t);
  }

  /** When the reference has no facing, world axes are used (forward = +y). */
  toReferenceLocal(player: PosSample, ref: PosSample, t = 0): RelPos {
    const dx = player.x - ref.x;
    const dy = player.y - ref.y;
    const facing = (ref.facing ?? Math.PI / 2) + FACING_OFFSET_RAD;
    const cos = Math.cos(facing), sin = Math.sin(facing);
    const fwd = dx * cos + dy * sin;
    const right = dx * sin - dy * cos;
    const dist = Math.hypot(dx, dy);
    return { t, fwd, right, dist, mapID: player.mapID };
  }

  rowsToTimeline(id: number, rows: PosRow[]): ActorTimeline {
    const samples: PosSample[] = rows.map(([t, x, y, facing, mapID]) => ({
      t,
      x: x * RAW_TO_YARDS,
      y: y * RAW_TO_YARDS,
      facing: facing == null ? undefined : facing * FACING_TO_RAD,
      mapID: mapID ?? undefined,
    }));
    return { id, samples };
  }

  /** Build the player timeline from stored [t, x, y, mapID] rows (player rows store no facing). */
  playerRowsToTimeline(id: number, rows: PlayerPosRow[]): ActorTimeline {
    const samples: PosSample[] = rows.map(([t, x, y, mapID]) => ({
      t,
      x: x * RAW_TO_YARDS,
      y: y * RAW_TO_YARDS,
      mapID: mapID ?? undefined,
    }));
    return { id, samples };
  }

  private refRows(parse: ParsePositions, selector: ReferenceSelector): PosRow[] | null {
    if (selector.kind === 'boss') {
      const boss = parse.enemies.find(enemy => enemy.is_boss) ?? parse.enemies[0];
      return boss?.samples ?? null;
    }
    return parse.enemies.find(enemy => enemy.game_id === selector.gameId)?.samples ?? null;
  }

  buildParseTimelines(positions: EncounterPositions, selector: ReferenceSelector): ParseTimelines[] {
    const out: ParseTimelines[] = [];
    for (const parse of positions.parses) {
      const rows = this.refRows(parse, selector);
      if (!rows) continue;
      out.push({ player: this.playerRowsToTimeline(-1, parse.player), ref: this.rowsToTimeline(-2, rows) });
    }
    return out;
  }

  parsePointsAt(timelines: ParseTimelines[], t: number): RelPos[] {
    const out: RelPos[] = [];
    for (const { player: playerTl, ref: refTl } of timelines) {
      const ref = this.positionAt(refTl, t);
      const player = this.positionAt(playerTl, t);
      if (ref && player && this.sameMap(player, ref)) out.push(this.toReferenceLocal(player, ref, t));
    }
    return out;
  }

  parseTrailsOf(
    timelines: ParseTimelines[], t: number, pre: number, post: number, step: number,
  ): RelPos[][] {
    const trails: RelPos[][] = [];
    for (const { player: playerTl, ref: refTl } of timelines) {
      const trail: RelPos[] = [];
      for (let tt = t - pre; tt <= t + post + 1e-6; tt += step) {
        const ref = this.positionAt(refTl, tt);
        const player = this.positionAt(playerTl, tt);
        if (ref && player && this.sameMap(player, ref)) trail.push(this.toReferenceLocal(player, ref, tt));
      }
      if (trail.length) trails.push(trail);
    }
    return trails;
  }

  buildTrail(
    actorId: number, refId: number, timelines: Map<number, ActorTimeline>,
    tCast: number, pre: number, post: number, step: number,
  ): RelPos[] {
    const trail: RelPos[] = [];
    const refTl = timelines.get(refId);
    const actorTl = timelines.get(actorId);
    for (let t = tCast - pre; t <= tCast + post + 1e-6; t += step) {
      const ref = this.positionAt(refTl, t);
      const player = this.positionAt(actorTl, t);
      if (ref && player && this.sameMap(player, ref)) trail.push(this.toReferenceLocal(player, ref, t));
    }
    return trail;
  }
}

/** Ported from `positioning-core` so the map components import no domain service - only this slice-local module + `MapFeatureService`. */
import { bisector } from 'd3-array';
import { EncounterPositions, ParsePositions, PlayerPosRow, PosRow, ReferenceSelector } from '../../../../domain/encounter/positioning.models';
import { ActorTimeline, PosSample, FACING_OFFSET_RAD } from '../facade/map-feature-service';
import { WclEvent } from '../../../../core/wcl/wcl.models';

const RAW_TO_YARDS = 1 / 100;
const FACING_TO_RAD = 1 / 1000;

export interface RelPos {
  t: number;
  /** Yards in front of (+) / behind (-) the reference's facing. */
  fwd: number;
  /** Yards to the right (+) / left (-) of the reference's facing. */
  right: number;
  /** Distance from the reference, yards. */
  dist: number;
  /** The map this relative frame sits on; a trail draws no segment where it changes. */
  mapID?: number;
}

const sampleBisector = bisector((sample: PosSample) => sample.t);

/** Depends only on the bench + selector, never on the scrubbed time, so it's built once per positions/selector and reused across every playback frame. */
export interface ParseTimelines { player: ActorTimeline; ref: ActorTimeline; }
