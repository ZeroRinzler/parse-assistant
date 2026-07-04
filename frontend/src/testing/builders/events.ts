/**
 * Plain factory functions for WCL combat-log event fixtures.
 *
 * Each factory returns a single `WclEvent` and hides the two WCL wire quirks
 * every spec would otherwise repeat: timestamps are in milliseconds (factories
 * take fight-relative *seconds* and convert), and event kinds are lowercase
 * wire strings (`'cast'`, `'applybuff'`, `'removebuff'`, `'damage'`). Optional
 * actor and absorb fields exist on the event only when the caller provides
 * them; an omitted opt leaves the field absent, not `undefined`.
 *
 * ```ts
 * const events = [cast(SHADOW_BLADES, 1), ...buffWindow(FEINT, 10, 16)];
 * ```
 */
import { WclEvent } from '../../app/core/models/wcl.models';

/** WCL timestamps are milliseconds; factory times are fight-relative seconds. */
const MS_PER_SECOND = 1000;

/** A player ability cast (`type: 'cast'`). */
export function cast(spellId: number, atS: number, opts?: { source?: number; target?: number }): WclEvent {
  return {
    type: 'cast',
    timestamp: atS * MS_PER_SECOND,
    abilityGameID: spellId,
    ...(opts?.source !== undefined && { sourceID: opts.source }),
    ...(opts?.target !== undefined && { targetID: opts.target }),
  };
}

/** A buff gained (`type: 'applybuff'`). A self-buff lands on its target, so `target` sets both actor fields. */
export function applyBuff(spellId: number, atS: number, opts?: { target?: number }): WclEvent {
  return {
    type: 'applybuff',
    timestamp: atS * MS_PER_SECOND,
    abilityGameID: spellId,
    ...(opts?.target !== undefined && { sourceID: opts.target, targetID: opts.target }),
  };
}

/** A buff lost (`type: 'removebuff'`). Same actor handling as {@link applyBuff}. */
export function removeBuff(spellId: number, atS: number, opts?: { target?: number }): WclEvent {
  return {
    type: 'removebuff',
    timestamp: atS * MS_PER_SECOND,
    abilityGameID: spellId,
    ...(opts?.target !== undefined && { sourceID: opts.target, targetID: opts.target }),
  };
}

/** A buff active from `fromS` until `toS`: the applybuff / removebuff pair. */
export function buffWindow(spellId: number, fromS: number, toS: number, opts?: { target?: number }): WclEvent[] {
  return [applyBuff(spellId, fromS, opts), removeBuff(spellId, toS, opts)];
}

/** Damage the player deals (`type: 'damage'`). */
export function damage(
  spellId: number,
  atS: number,
  amount: number,
  opts?: { source?: number; target?: number; absorbed?: number },
): WclEvent {
  return {
    type: 'damage',
    timestamp: atS * MS_PER_SECOND,
    abilityGameID: spellId,
    amount,
    ...(opts?.absorbed !== undefined && { absorbed: opts.absorbed }),
    ...(opts?.source !== undefined && { sourceID: opts.source }),
    ...(opts?.target !== undefined && { targetID: opts.target }),
  };
}

/** Damage dealt TO the player (`type: 'damage'`): `source` is the attacker, and no target actor is set. */
export function damageTaken(
  spellId: number,
  atS: number,
  amount: number,
  opts?: { source?: number; absorbed?: number },
): WclEvent {
  return {
    type: 'damage',
    timestamp: atS * MS_PER_SECOND,
    abilityGameID: spellId,
    amount,
    ...(opts?.absorbed !== undefined && { absorbed: opts.absorbed }),
    ...(opts?.source !== undefined && { sourceID: opts.source }),
  };
}
