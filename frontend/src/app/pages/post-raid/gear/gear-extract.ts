/**
 * Slice-local gear projection helpers shared between the gear transform service
 * (ingest / live bench) and the gear feature service (player gear). This is a
 * within-slice, gear-domain module - analogous to the cross-slice presentational
 * `shared/gear/gear-comparison.ts` - so both files import one copy instead of
 * duplicating the projection. It owns no Angular / IO; pure functions only.
 */
import { CharacterGear, WclGearItem } from '../../../core/models/wcl.models';

/**
 * Trinket slots, per the WCL gear quirk: the CombatantInfo gear array is
 * positionally indexed (the index IS the slot), and the two trinket slots are
 * indices 12 (Trinket 1) and 13 (Trinket 2).
 */
export const TRINKET_SLOTS = [12, 13] as const;

/** Normalize a WCL gear icon ("inv_x.jpg") to the bare filename used by zamimg. */
export function iconFile(icon?: string): string {
  return (icon ?? '').replace(/\.jpg$/i, '');
}

/** Decode HTML entities in a string returned by WCL's gameData queries. */
export function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/** Extract trinkets (slots 12/13) and enchants from a CombatantInfo gear array. */
export function extractGear(gear: WclGearItem[] | undefined): {
  trinkets: NonNullable<CharacterGear['trinkets']>;
  enchants: NonNullable<CharacterGear['enchants']>;
} {
  const trinkets: NonNullable<CharacterGear['trinkets']> = [];
  const enchants: NonNullable<CharacterGear['enchants']> = [];

  (gear ?? []).forEach((item, slotIndex) => {
    if (item?.id == null) return;
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
