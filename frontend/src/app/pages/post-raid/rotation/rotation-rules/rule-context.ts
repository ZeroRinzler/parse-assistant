import { getOrInsert } from '../../../../shared/analysis/analysis-math';
import { TimedEvent, targetKey } from '../../../../shared/analysis/wcl-projections';
import {
  AuraWindows, AuraSpansByTarget, StackTimeline,
  buildAuraWindows, buildStackTimeline, buildAuraSpansByTarget, auraUpAt,
} from '../../../../shared/analysis/aura-windows';

/** WCL flattens one actor's pools onto the event; 1 means they belong to the caster. */
export const RESOURCE_ACTOR_SOURCE = 1;

/** The other half of the same field: 2 means the snapshot describes whoever was hit. */
const RESOURCE_ACTOR_TARGET = 2;

export type CastTimes = Record<number, number[]>;

function buildCastTimes(casts: TimedEvent[]): CastTimes {
  const castTimes: CastTimes = {};
  for (const cast of casts) {
    if (cast.type === 'cast' && cast.abilityGameID) {
      (castTimes[cast.abilityGameID] ??= []).push(cast.atS);
    }
  }
  return castTimes;
}

/** Damage rows as `[atS, targetKey]`, time-ordered so a window is a slice rather than a scan. */
export type DamageRow = [number, string];

/** One enemy's health as `[atS, share of max]`, time-ordered. */
export type HealthRow = [number, number];

/** One cast's pool as `[atS, amount the cast left behind, max]`, time-ordered. */
export type ResourceRow = [number, number, number];

export interface RuleContext {
  castTimes: CastTimes;
  castEvents: TimedEvent[];
  fightDurationS: number;
  selfAuras: AuraWindows;
  targetAuras: AuraWindows;
  /** Called rather than read: each builds on first use, and only for the one aura the rule names. */
  stacks: (spellId: number) => StackTimeline;
  selfSpans: (spellId: number) => AuraSpansByTarget;
  targetSpans: (spellId: number) => AuraSpansByTarget;
  damageIndex: () => readonly DamageRow[];
  targetHealth: (key: string) => readonly HealthRow[];
  resourcePool: (resourceType: number) => readonly ResourceRow[];
}

/** Built on first call and kept, so a stream no rulebook asks about costs nothing. */
function lazy<T extends object>(build: () => T): () => T {
  let value: T | undefined;
  return () => (value ??= build());
}

function perId<T extends object>(build: (id: number) => T): (id: number) => T {
  const cache = new Map<number, T>();
  return id => getOrInsert(cache, id, () => build(id));
}

function buildDamageIndex(damage: TimedEvent[]): DamageRow[] {
  return damage.map((event): DamageRow => [event.atS, targetKey(event)]).sort((a, b) => a[0] - b[0]);
}

/** `amount` is pre-cost, so the pool a cast leaves behind is what the next cast starts from; between the two only generation can raise it, which keeps an overcap read conservative. */
function buildResourceIndex(casts: TimedEvent[], resourceType: number): ResourceRow[] {
  const rows: ResourceRow[] = [];
  for (const event of casts) {
    if (event.type !== 'cast') continue;
    if (event.resourceActor != null && event.resourceActor !== RESOURCE_ACTOR_SOURCE) continue;
    const pool = event.classResources?.find(resource => resource.type === resourceType);
    if (!pool?.max) continue;
    rows.push([event.atS, Math.max(0, pool.amount - (pool.cost ?? 0)), pool.max]);
  }
  return rows.sort((a, b) => a[0] - b[0]);
}

/** Only the resource-bearing rows carry health, and only for whoever was hit. */
function buildHealthIndex(damage: TimedEvent[]): Map<string, HealthRow[]> {
  const index = new Map<string, HealthRow[]>();
  for (const event of damage) {
    if (event.resourceActor !== RESOURCE_ACTOR_TARGET || event.hitPoints == null || !event.maxHitPoints) continue;
    getOrInsert(index, targetKey(event), (): HealthRow[] => []).push([event.atS, event.hitPoints / event.maxHitPoints]);
  }
  for (const rows of index.values()) rows.sort((a, b) => a[0] - b[0]);
  return index;
}

export interface RuleInputs {
  casts: TimedEvent[];
  buffs: TimedEvent[];
  debuffs: TimedEvent[];
  damage: TimedEvent[];
  fightDurationS: number;
}

export function buildRuleContext(input: RuleInputs): RuleContext {
  const { casts, buffs, debuffs, damage, fightDurationS } = input;
  const health = lazy(() => buildHealthIndex(damage));
  return {
    castTimes: buildCastTimes(casts),
    castEvents: casts,
    fightDurationS,
    selfAuras: buildAuraWindows(buffs),
    targetAuras: buildAuraWindows(debuffs),
    stacks: perId(spellId => buildStackTimeline(buffs, spellId)),
    selfSpans: perId(spellId => buildAuraSpansByTarget(buffs, spellId)),
    targetSpans: perId(spellId => buildAuraSpansByTarget(debuffs, spellId)),
    damageIndex: lazy(() => buildDamageIndex(damage)),
    targetHealth: key => health().get(key) ?? [],
    resourcePool: perId(resourceType => buildResourceIndex(casts, resourceType)),
  };
}

export function castCount(ctx: RuleContext, spellId: number): number {
  return ctx.castTimes[spellId]?.length ?? 0;
}

/** A state the rule agreed not to judge under, so a window the sources say to press the other button in is not counted against the player. */
export function suspendedAt(exceptIds: number[] | undefined, ctx: RuleContext, timeS: number): boolean {
  return (exceptIds ?? []).some(spellId => auraUpAt(ctx.selfAuras, spellId, timeS));
}
