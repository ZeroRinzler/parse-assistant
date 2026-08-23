import { Injectable } from '@angular/core';
import { CharacterGear, WclCombatantInfo, WclGearItem } from '../../../../core/wcl/wcl.models';

@Injectable({ providedIn: 'root' })
export class GearExtractService {

  // WCL keys the CombatantInfo event by sourceID; falls back to the first event when there is no exact match.
  selectCombatantInfo(
    events: WclCombatantInfo[], playerId: number,
  ): WclCombatantInfo | null {
    return events.find(event => event.sourceID === playerId) ?? events[0] ?? null;
  }

  iconFile(icon?: string): string {
    return (icon ?? '').replace(/\.jpg$/i, '');
  }

  decodeHtmlEntities(text: string): string {
    return text.replace(/&(?:amp|lt|gt|quot|#39);/g, entity => HTML_ENTITIES[entity] ?? entity);
  }

  /** Fills in the names WCL left blank on the gear rows themselves, in place. */
  fillGameNames(items: { id: number; name: string }[], prefix: 'i' | 'e', names: GameNames): void {
    for (const item of items) {
      if (!item.name && item.id) item.name = this.decodeHtmlEntities(names[`${prefix}${item.id}`]?.name ?? '');
    }
  }

  extractGear(gear: WclGearItem[] | undefined): {
    trinkets: NonNullable<CharacterGear['trinkets']>;
    enchants: NonNullable<CharacterGear['enchants']>;
  } {
    const trinkets: NonNullable<CharacterGear['trinkets']> = [];
    const enchants: NonNullable<CharacterGear['enchants']> = [];

    (gear ?? []).forEach((item, slotIndex) => {
      if (!item.id) return;
      const itemId = typeof item.id === 'string' ? parseInt(item.id, 10) : item.id;

      if ((TRINKET_SLOTS as readonly number[]).includes(slotIndex)) {
        trinkets.push({ slot: slotIndex, id: itemId, name: item.name ?? '', icon: this.iconFile(item.icon) });
      }

      const enchant = item.permanentEnchant;
      if (enchant) {
        const enchantId = typeof enchant === 'string' ? parseInt(enchant, 10) : enchant;
        enchants.push({ slot: slotIndex, id: enchantId, name: item.permanentEnchantName ?? '' });
      }
    });

    return { trinkets, enchants };
  }
}

// WCL's CombatantInfo gear array is positionally indexed (the index IS the slot); trinkets are 12 and 13.
export const TRINKET_SLOTS = [12, 13] as const;

const HTML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
};

/** A WCL game-name batch, keyed by the alias the query built: `i` plus an item id, `e` plus an enchant id. */
export type GameNames = Record<string, { id: number; name: string }>;
