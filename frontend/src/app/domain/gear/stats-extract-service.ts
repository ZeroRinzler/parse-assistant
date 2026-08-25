import { Injectable } from '@angular/core';
import { SecondaryStats, WclCombatantInfo, WclGearItem } from '../../core/wcl/wcl.models';

// Lives in domain/ (not the gear slice's data-access) because the talents/stats slices read the same combatant-info extraction.
@Injectable({ providedIn: 'root' })
export class StatsExtractService {

  // Only one of strength/agility/intellect is meaningfully populated per class; the others sit near a low baseline.
  extractStats(event: WclCombatantInfo): SecondaryStats {
    const n = (value: number | undefined): number => value ?? 0;
    return {
      primary: Math.max(n(event.strength), n(event.agility), n(event.intellect)),
      stamina: n(event.stamina),
      crit: n(event.critMelee),
      haste: n(event.hasteMelee),
      mastery: n(event.mastery),
      versatility: n(event.versatilityDamageDone),
      avoidance: n(event.avoidance),
      leech: n(event.leech),
      speed: n(event.speed),
    };
  }

  // A vacant slot reports itemLevel 0; a cosmetic-only slot (e.g. Shirt) reports 1. Neither is a real equipped piece.
  averageItemLevel(gear: WclGearItem[] | undefined): number | undefined {
    const levels = (gear ?? []).map(item => item.itemLevel ?? 0).filter(level => level > 1);
    if (!levels.length) return undefined;
    return levels.reduce((sum, level) => sum + level, 0) / levels.length;
  }
}
