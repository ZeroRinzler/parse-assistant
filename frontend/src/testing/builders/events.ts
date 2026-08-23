/** Factories for `WclEvent` fixtures; an omitted opt leaves the field absent on the event, not `undefined`. */
import { WclEvent } from '../../app/core/wcl/wcl.models';

/** WCL timestamps are milliseconds; factory times are fight-relative seconds. */
const MS_PER_SECOND = 1000;

/** A player ability cast (`type: 'cast'`). `resources` mirrors what `includeResources: true` flattens onto the event. */
export function cast(
  spellId: number, atS: number,
  opts?: { source?: number; target?: number; resources?: { amount: number; max?: number; type: number; cost?: number }[] },
): WclEvent {
  return {
    type: 'cast',
    timestamp: atS * MS_PER_SECOND,
    abilityGameID: spellId,
    ...(opts?.source !== undefined && { sourceID: opts.source }),
    ...(opts?.target !== undefined && { targetID: opts.target }),
    ...(opts?.resources !== undefined && { resourceActor: 1, classResources: opts.resources }),
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

export function applyDebuff(spellId: number, atS: number, opts?: { target?: number }): WclEvent {
  return {
    type: 'applydebuff',
    timestamp: atS * MS_PER_SECOND,
    abilityGameID: spellId,
    ...(opts?.target !== undefined && { targetID: opts.target }),
  };
}

export function refreshDebuff(spellId: number, atS: number, opts?: { target?: number }): WclEvent {
  return {
    type: 'refreshdebuff',
    timestamp: atS * MS_PER_SECOND,
    abilityGameID: spellId,
    ...(opts?.target !== undefined && { targetID: opts.target }),
  };
}

/** A buff climbing to `stack` (`type: 'applybuffstack'`), which carries the new total rather than the increment. */
export function applyBuffStack(spellId: number, atS: number, stack: number, opts?: { target?: number }): WclEvent {
  return {
    type: 'applybuffstack',
    timestamp: atS * MS_PER_SECOND,
    abilityGameID: spellId,
    stack,
    ...(opts?.target !== undefined && { sourceID: opts.target, targetID: opts.target }),
  };
}

export function removeDebuff(spellId: number, atS: number, opts?: { target?: number }): WclEvent {
  return {
    type: 'removedebuff',
    timestamp: atS * MS_PER_SECOND,
    abilityGameID: spellId,
    ...(opts?.target !== undefined && { targetID: opts.target }),
  };
}

export function buffWindow(spellId: number, fromS: number, toS: number, opts?: { target?: number }): WclEvent[] {
  return [applyBuff(spellId, fromS, opts), removeBuff(spellId, toS, opts)];
}

export function damage(
  spellId: number,
  atS: number,
  amount: number,
  opts?: { source?: number; target?: number; absorbed?: number; targetHealthPct?: number },
): WclEvent {
  const MAX_HP = 1_000_000;
  return {
    type: 'damage',
    timestamp: atS * MS_PER_SECOND,
    abilityGameID: spellId,
    amount,
    ...(opts?.absorbed !== undefined && { absorbed: opts.absorbed }),
    ...(opts?.source !== undefined && { sourceID: opts.source }),
    ...(opts?.target !== undefined && { targetID: opts.target }),
    // What `includeResources: true` flattens on for the struck actor, which is where target health lives.
    ...(opts?.targetHealthPct !== undefined && {
      resourceActor: 2, maxHitPoints: MAX_HP, hitPoints: Math.round(MAX_HP * opts.targetHealthPct / 100),
    }),
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
