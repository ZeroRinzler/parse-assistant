import { CharacterGear, WclCombatantInfo, WclGearItem } from '../../../core/models/wcl.models';

// WCL keys the CombatantInfo event by sourceID; falls back to the first event when there is no exact match.
export function selectCombatantInfo(
  events: WclCombatantInfo[], playerId: number,
): WclCombatantInfo | null {
  return events.find(event => event.sourceID === playerId) ?? events[0] ?? null;
}

// WCL's CombatantInfo gear array is positionally indexed (the index IS the slot); trinkets are 12 and 13.
export const TRINKET_SLOTS = [12, 13] as const;

export function iconFile(icon?: string): string {
  return (icon ?? '').replace(/\.jpg$/i, '');
}

const HTML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
};

export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|#39);/g, entity => HTML_ENTITIES[entity] ?? entity);
}

export function extractGear(gear: WclGearItem[] | undefined): {
  trinkets: NonNullable<CharacterGear['trinkets']>;
  enchants: NonNullable<CharacterGear['enchants']>;
} {
  const trinkets: NonNullable<CharacterGear['trinkets']> = [];
  const enchants: NonNullable<CharacterGear['enchants']> = [];

  (gear ?? []).forEach((item, slotIndex) => {
    if (!item.id) return;
    const itemId = typeof item.id === 'string' ? parseInt(item.id, 10) : item.id;

    if ((TRINKET_SLOTS as readonly number[]).includes(slotIndex)) {
      trinkets.push({ slot: slotIndex, id: itemId, name: item.name ?? '', icon: iconFile(item.icon) });
    }

    const enchant = item.permanentEnchant;
    if (enchant) {
      const enchantId = typeof enchant === 'string' ? parseInt(enchant, 10) : enchant;
      enchants.push({ slot: slotIndex, id: enchantId, name: item.permanentEnchantName ?? '' });
    }
  });

  return { trinkets, enchants };
}
