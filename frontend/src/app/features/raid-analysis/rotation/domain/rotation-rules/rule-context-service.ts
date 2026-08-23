import { Injectable, inject } from '@angular/core';
import { getOrInsert } from '../../../../../domain/analysis/analysis-math';
import { WclProjectionsService, TimedEvent } from '../../../../../domain/analysis/wcl-projections-service';
import { AuraWindowsService, AuraWindows, AuraSpansByTarget, StackTimeline } from '../../../../../domain/analysis/aura-windows-service';

/** WCL flattens one actor's pools onto the event; 1 means they belong to the caster. */
export const RESOURCE_ACTOR_SOURCE = 1;

/** The other half of the same field: 2 means the snapshot describes whoever was hit. */
const RESOURCE_ACTOR_TARGET = 2;

export type CastTimes = Record<number, number[]>;

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

export interface RuleInputs {
  casts: TimedEvent[];
  buffs: TimedEvent[];
  debuffs: TimedEvent[];
  damage: TimedEvent[];
  fightDurationS: number;
}

@Injectable({ providedIn: 'root' })
export class RuleContextService {
  private readonly auraWindows = inject(AuraWindowsService);
  private readonly projections = inject(WclProjectionsService);

  buildRuleContext(input: RuleInputs): RuleContext {
    const { casts, buffs, debuffs, damage, fightDurationS } = input;
    const health = this.lazy(() => this.buildHealthIndex(damage));
    return {
      castTimes: this.buildCastTimes(casts),
      castEvents: casts,
      fightDurationS,
      selfAuras: this.auraWindows.buildAuraWindows(buffs),
      targetAuras: this.auraWindows.buildAuraWindows(debuffs),
      stacks: this.perId(spellId => this.auraWindows.buildStackTimeline(buffs, spellId)),
      selfSpans: this.perId(spellId => this.auraWindows.buildAuraSpansByTarget(buffs, spellId)),
      targetSpans: this.perId(spellId => this.auraWindows.buildAuraSpansByTarget(debuffs, spellId)),
      damageIndex: this.lazy(() => this.buildDamageIndex(damage)),
      targetHealth: key => health().get(key) ?? [],
      resourcePool: this.perId(resourceType => this.buildResourceIndex(casts, resourceType)),
    };
  }

  private buildCastTimes(casts: TimedEvent[]): CastTimes {
    const castTimes: CastTimes = {};
    for (const cast of casts) {
      if (cast.type === 'cast' && cast.abilityGameID) {
        (castTimes[cast.abilityGameID] ??= []).push(cast.atS);
      }
    }
    return castTimes;
  }

  /** Built on first call and kept, so a stream no rulebook asks about costs nothing. */
  private lazy<T extends object>(build: () => T): () => T {
    let value: T | undefined;
    return () => (value ??= build());
  }

  private perId<T extends object>(build: (id: number) => T): (id: number) => T {
    const cache = new Map<number, T>();
    return id => getOrInsert(cache, id, () => build(id));
  }

  private buildDamageIndex(damage: TimedEvent[]): DamageRow[] {
    return damage.map((event): DamageRow => [event.atS, this.projections.targetKey(event)]).sort((a, b) => a[0] - b[0]);
  }

  /** `amount` is pre-cost, so the pool a cast leaves behind is what the next cast starts from; between the two only generation can raise it, which keeps an overcap read conservative. */
  private buildResourceIndex(casts: TimedEvent[], resourceType: number): ResourceRow[] {
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
  private buildHealthIndex(damage: TimedEvent[]): Map<string, HealthRow[]> {
    const index = new Map<string, HealthRow[]>();
    for (const event of damage) {
      if (event.resourceActor !== RESOURCE_ACTOR_TARGET || event.hitPoints == null || !event.maxHitPoints) continue;
      getOrInsert(index, this.projections.targetKey(event), (): HealthRow[] => []).push([event.atS, event.hitPoints / event.maxHitPoints]);
    }
    for (const rows of index.values()) rows.sort((a, b) => a[0] - b[0]);
    return index;
  }
}
