import { Injectable, inject } from '@angular/core';
import { AuraWindows, AuraWindowsService } from './aura-windows-service';
import { TimedEvent } from './wcl-projections-service';

/** Whether a notable external buff/consumable was up during one burst window, compare-mode only. */
export interface WindowBuffPresence {
  potion: boolean;
  powerInfusion: boolean;
  bloodlust: boolean;
  /** The window's own recommended major cooldowns (e.g. Trueshot), keyed by spell id. */
  cooldowns: Record<number, boolean>;
}

/** Power Infusion - stable across expansions, unlike consumable ids which change every tier. */
const POWER_INFUSION_ID = 10060;
/** Bloodlust / Heroism / Time Warp and equivalents - mirrors `RotationBloodlustService`'s list. */
const BLOODLUST_IDS = new Set([2825, 32182, 80353, 90355, 264667, 390386]);

interface BuffContext {
  windows: AuraWindows;
  /** Spell ids the player self-applied whose ability name matches a potion. */
  selfPotionIds: Set<number>;
}

@Injectable({ providedIn: 'root' })
export class BuffPresenceService {
  private readonly auraWindows = inject(AuraWindowsService);

  // `sourceID` is the real caster even on a `Buffs` fetch filtered to the target player, so it tells self- from external buffs apart.
  private buildContext(buffEvents: TimedEvent[], playerId: number, abilityNames: Map<number, string>): BuffContext {
    const windows = this.auraWindows.buildAuraWindows(buffEvents);
    const selfPotionIds = new Set<number>();
    for (const event of buffEvents) {
      if (event.type !== 'applybuff' && event.type !== 'refreshbuff') continue;
      if (event.sourceID != null && event.sourceID !== playerId) continue;
      const name = abilityNames.get(event.abilityGameID);
      if (name && /potion/i.test(name)) selfPotionIds.add(event.abilityGameID);
    }
    return { windows, selfPotionIds };
  }

  private overlaps(windows: AuraWindows, spellId: number, startS: number, endS: number): boolean {
    return (windows.get(spellId) ?? []).some(([start, end]) => start < endS && (end ?? Infinity) > startS);
  }

  private presenceFor(ctx: BuffContext, startS: number, endS: number, cooldownIds: number[]): WindowBuffPresence {
    const cooldowns: Record<number, boolean> = {};
    for (const id of cooldownIds) cooldowns[id] = this.overlaps(ctx.windows, id, startS, endS);
    return {
      potion: [...ctx.selfPotionIds].some(id => this.overlaps(ctx.windows, id, startS, endS)),
      powerInfusion: this.overlaps(ctx.windows, POWER_INFUSION_ID, startS, endS),
      bloodlust: [...BLOODLUST_IDS].some(id => this.overlaps(ctx.windows, id, startS, endS)),
      cooldowns,
    };
  }

  /** One presence entry per `windows` slot; each carries its own `cooldownIds` since recommended cooldowns vary per window. */
  windowsPresence(
    buffEvents: TimedEvent[], playerId: number, abilityNames: Map<number, string>,
    windows: { startS: number; endS: number; cooldownIds: number[] }[],
  ): WindowBuffPresence[] {
    const ctx = this.buildContext(buffEvents, playerId, abilityNames);
    return windows.map(w => this.presenceFor(ctx, w.startS, w.endS, w.cooldownIds));
  }
}
