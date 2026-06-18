/**
 * Fluent builder for WCL event streams.
 *
 * WCL combat-log rows are massive and full of domain quirks (ms timestamps,
 * `resourceActor` source/target mapping, coordinates in hundredths of a yard,
 * facing in milliradians). This builder hides all of that behind a readable,
 * chainable API so a test reads as a sentence:
 *
 * ```ts
 * const casts = Events.cast(SHADOW_BLADES, "0:01").cast(SHADOW_BLADES, "1:30").build();
 * const buffs = Events.start().applyBuff(BLOODLUST, "0:15").build();
 * ```
 *
 * Defaults: the player is actor `1`, the boss is actor `2`. Times are "m:ss"
 * strings (or seconds) relative to fight start; with `FIGHT_START = 0` they map
 * straight onto the fight-relative timestamps the analysis engine computes.
 */
import { WclEvent } from '../../app/core/models/wcl.models';
import { parseClock } from '../time';

/** Default actor IDs the builder wires events to. */
export const PLAYER = 1;
export const BOSS = 2;

export class Events {
  private readonly rows: WclEvent[] = [];

  private constructor() {}

  /** Start an empty stream. */
  static start(): Events {
    return new Events();
  }

  /** Start a stream with a first cast in one call: `Events.cast(SB, "0:01")`. */
  static cast(spellId: number, t: string | number, opts?: { source?: number; target?: number }): Events {
    return new Events().cast(spellId, t, opts);
  }

  /** A player ability cast (`type: 'cast'`). */
  cast(spellId: number, t: string | number, opts?: { source?: number; target?: number }): this {
    this.rows.push({
      type: 'cast',
      timestamp: parseClock(t),
      abilityGameID: spellId,
      sourceID: opts?.source ?? PLAYER,
      targetID: opts?.target ?? BOSS,
    });
    return this;
  }

  /** Buff gained (`type: 'applybuff'`), e.g. a defensive or Bloodlust starting. */
  applyBuff(spellId: number, t: string | number, opts?: { target?: number }): this {
    const actor = opts?.target ?? PLAYER;
    this.rows.push({ type: 'applybuff', timestamp: parseClock(t), abilityGameID: spellId, sourceID: actor, targetID: actor });
    return this;
  }

  /** Buff lost (`type: 'removebuff'`). */
  removeBuff(spellId: number, t: string | number, opts?: { target?: number }): this {
    const actor = opts?.target ?? PLAYER;
    this.rows.push({ type: 'removebuff', timestamp: parseClock(t), abilityGameID: spellId, sourceID: actor, targetID: actor });
    return this;
  }

  /** Convenience: a buff that is active from `from` until `to` (apply + remove). */
  buffWindow(spellId: number, from: string | number, to: string | number, opts?: { target?: number }): this {
    return this.applyBuff(spellId, from, opts).removeBuff(spellId, to, opts);
  }

  /** Damage the player deals (`type: 'damage'`, source = player -> target = boss). */
  damage(spellId: number, t: string | number, amount: number, opts?: { absorbed?: number; target?: number }): this {
    this.rows.push({
      type: 'damage',
      timestamp: parseClock(t),
      abilityGameID: spellId,
      amount,
      absorbed: opts?.absorbed ?? 0,
      sourceID: PLAYER,
      targetID: opts?.target ?? BOSS,
    });
    return this;
  }

  /** Damage taken BY the player (`type: 'damage'`, source = boss -> target = player). */
  damageTaken(spellId: number, t: string | number, amount: number, opts?: { absorbed?: number; source?: number }): this {
    this.rows.push({
      type: 'damage',
      timestamp: parseClock(t),
      abilityGameID: spellId,
      amount,
      absorbed: opts?.absorbed ?? 0,
      sourceID: opts?.source ?? BOSS,
      targetID: PLAYER,
    });
    return this;
  }

  /**
   * A positioned cast. Inputs are human units (yards and degrees); the builder
   * encodes the WCL wire units (hundredths of a yard, milliradians) and the
   * `resourceActor` flag so positioning-core tests read in plain coordinates.
   */
  positioned(
    spellId: number,
    t: string | number,
    x: number,
    y: number,
    facingDeg = 0,
    opts?: { source?: number; target?: number; mapID?: number },
  ): this {
    this.rows.push({
      type: 'cast',
      timestamp: parseClock(t),
      abilityGameID: spellId,
      sourceID: opts?.source ?? PLAYER,
      targetID: opts?.target ?? BOSS,
      resourceActor: 1,
      x: Math.round(x * 100),
      y: Math.round(y * 100),
      facing: Math.round(((facingDeg * Math.PI) / 180) * 1000),
      mapID: opts?.mapID ?? 0,
    });
    return this;
  }

  /** Append an arbitrary raw event (escape hatch for exotic cases). */
  raw(event: WclEvent): this {
    this.rows.push(event);
    return this;
  }

  /** Materialize the accumulated events as a fresh array. */
  build(): WclEvent[] {
    return this.rows.slice();
  }
}
