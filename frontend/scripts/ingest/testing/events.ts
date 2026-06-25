/**
 * Fluent builder for WCL event streams in ingest tests.
 *
 * Mirrors src/testing/builders/events but emits the ingest-side
 * `WclResourceEvent` (which carries `maxHitPoints` and lets any actor be the
 * source/target), so analysis tests for positions, boss detection, and damage
 * taken read as sentences instead of raw event literals.
 *
 * Defaults: player is actor 1, boss is actor 2. Times are "m:ss" strings (or
 * seconds); with FIGHT_START = 0 they map straight onto fight-relative timestamps.
 */

import { parseClock } from './clock.ts';
import type { WclResourceEvent } from '../models/wcl.models.ts';

export const PLAYER = 1;
export const BOSS = 2;

export class Events {
  private readonly rows: WclResourceEvent[] = [];

  private constructor() {}

  static start(): Events {
    return new Events();
  }

  static cast(spellId: number, time: string | number, opts?: { source?: number; target?: number }): Events {
    return new Events().cast(spellId, time, opts);
  }

  /** A player ability cast. */
  cast(spellId: number, time: string | number, opts?: { source?: number; target?: number }): this {
    this.rows.push({
      type: 'cast',
      timestamp: parseClock(time),
      abilityGameID: spellId,
      sourceID: opts?.source ?? PLAYER,
      targetID: opts?.target ?? BOSS,
    });
    return this;
  }

  /** Buff gained (defensive, Bloodlust, ...). Defaults to the player on themself. */
  applyBuff(spellId: number, time: string | number, opts?: { target?: number }): this {
    const actor = opts?.target ?? PLAYER;
    this.rows.push({ type: 'applybuff', timestamp: parseClock(time), abilityGameID: spellId, sourceID: actor, targetID: actor });
    return this;
  }

  /** Buff lost. */
  removeBuff(spellId: number, time: string | number, opts?: { target?: number }): this {
    const actor = opts?.target ?? PLAYER;
    this.rows.push({ type: 'removebuff', timestamp: parseClock(time), abilityGameID: spellId, sourceID: actor, targetID: actor });
    return this;
  }

  /** Convenience: a buff active from `from` until `to`. */
  buffWindow(spellId: number, from: string | number, to: string | number, opts?: { target?: number }): this {
    return this.applyBuff(spellId, from, opts).removeBuff(spellId, to, opts);
  }

  /** Damage the player deals (source = player -> target = boss by default). */
  damage(spellId: number, time: string | number, amount: number, opts?: { absorbed?: number; target?: number }): this {
    this.rows.push({
      type: 'damage',
      timestamp: parseClock(time),
      abilityGameID: spellId,
      amount,
      absorbed: opts?.absorbed ?? 0,
      sourceID: PLAYER,
      targetID: opts?.target ?? BOSS,
    });
    return this;
  }

  /** Damage taken BY the player (source = an enemy -> target = player). */
  damageTaken(spellId: number, time: string | number, amount: number, opts?: { absorbed?: number; source?: number }): this {
    this.rows.push({
      type: 'damage',
      timestamp: parseClock(time),
      abilityGameID: spellId,
      amount,
      absorbed: opts?.absorbed ?? 0,
      sourceID: opts?.source ?? BOSS,
      targetID: PLAYER,
    });
    return this;
  }

  /**
   * A resource-bearing position snapshot for `actorId`. x/y/facing/mapID are
   * stored raw (the analyzer scales nothing); `maxHp` drives boss detection.
   * resourceActor defaults to 1 (the source carries the snapshot).
   */
  position(
    actorId: number, time: string | number, x: number, y: number,
    opts?: { facing?: number; mapID?: number; maxHp?: number; resourceActor?: number },
  ): this {
    this.rows.push({
      type: 'cast',
      timestamp: parseClock(time),
      sourceID: actorId,
      resourceActor: opts?.resourceActor ?? 1,
      x, y,
      facing: opts?.facing,
      mapID: opts?.mapID,
      maxHitPoints: opts?.maxHp,
    });
    return this;
  }

  /** Append an arbitrary raw event (escape hatch for exotic cases). */
  raw(event: WclResourceEvent): this {
    this.rows.push(event);
    return this;
  }

  /** Materialize the accumulated events as a fresh array. */
  build(): WclResourceEvent[] {
    return this.rows.slice();
  }
}
