/**
 * Pure mapping/transformation functions for WCL API responses.
 *
 * These functions have no side effects and no Angular/HTTP dependencies.
 * They belong here and not inside the transport service so the API contract
 * can evolve independently of the application models.
 */
import { CharacterGear, WclUserCharacter } from '../models/wcl.models';

// ---------------------------------------------------------------------------
// Internal WCL response shapes (not part of the application model)
// ---------------------------------------------------------------------------

export interface WclGearItem {
  id?: number | string;
  name?: string;
  icon?: string;
  permanentEnchant?: number | string;
  permanentEnchantName?: string;
  gems?: Array<{ id?: number | string }>;
}

export interface WclTalentNode { node?: { nodeId?: number }; nodeId?: number; }
export interface WclTalentTree {
  class?: Record<string, WclTalentNode[]>;
  spec?: Record<string, WclTalentNode[]>;
}

export interface WclRankEntry {
  startTime?: number;
  spec?: string;
  class?: number;
  report?: { code?: string };
  gear?: WclGearItem[];
  talents?: WclTalentTree;
}

export interface PlayerDetailEntry {
  id: number;
  type: string;
  name: string;
  specs?: Array<{ spec: string }>;
}
export type PlayerDetailGroups = Record<string, PlayerDetailEntry[]>;

// ---------------------------------------------------------------------------
// WCL class-ID → spec-folder-name map
// ---------------------------------------------------------------------------

/** WCL numeric class ID → class name used in the spec folder path. */
export const CLASS_NAMES: Record<number, string> = {
  1: 'DeathKnight', 2: 'Druid', 3: 'Hunter', 4: 'Mage', 5: 'Monk',
  6: 'Paladin', 7: 'Priest', 8: 'Rogue', 9: 'Shaman', 10: 'Warlock',
  11: 'Warrior', 12: 'DemonHunter', 13: 'Evoker',
};

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

/** Normalize a WCL gear icon ("inv_x.jpg") to the bare filename used by zamimg. */
export function iconFile(icon?: string): string {
  return (icon ?? '').replace(/\.jpg$/i, '');
}

/**
 * Build the player-id -> spec-string map from a `playerDetails` response.
 * Also populates `name_<id>` entries for player-name lookups.
 */
export function buildSpecMap(groups: PlayerDetailGroups): Record<number | string, string> {
  const map: Record<number | string, string> = {};
  for (const role of ['dps', 'healers', 'tanks', 'unknown']) {
    for (const player of (groups[role] ?? [])) {
      const className = (player.type ?? '').replace(/ /g, '');
      const spec = ((player.specs ?? [])[0]?.spec ?? '').replace(/ /g, '');
      if (spec && className) map[player.id] = spec + className;
      if (player.name) map[`name_${player.id}`] = player.name;
    }
  }
  return map;
}

/** Map raw WCL character list entries to the application `WclUserCharacter` model. */
export function mapUserCharacters(
  raw: Array<{ id: number; name: string; server: { slug: string; region: { slug: string } } }>,
): WclUserCharacter[] {
  return raw.map(character => ({
    id: character.id,
    name: character.name,
    serverSlug: character.server?.slug ?? '',
    serverRegion: character.server?.region?.slug ?? '',
  }));
}

/** Extract trinkets, enchants, and filled-socket count from a ranking's combatant info. */
export function extractGear(entry: WclRankEntry): {
  trinkets: NonNullable<CharacterGear['trinkets']>;
  enchants: NonNullable<CharacterGear['enchants']>;
  gem_count: number;
} {
  const trinkets: NonNullable<CharacterGear['trinkets']> = [];
  const enchants: NonNullable<CharacterGear['enchants']> = [];
  let gem_count = 0;

  (entry.gear ?? []).forEach((item, slotIndex) => {
    if (item?.id == null) return;
    const itemId = typeof item.id === 'string' ? parseInt(item.id, 10) : item.id;

    if (slotIndex === 12 || slotIndex === 13) {
      trinkets.push({ slot: slotIndex, id: itemId, name: item.name ?? '', icon: iconFile(item.icon) });
    }

    const enchant = item.permanentEnchant;
    if (enchant) {
      const enchantId = typeof enchant === 'string' ? parseInt(enchant, 10) : enchant;
      enchants.push({ slot: slotIndex, id: enchantId, name: item.permanentEnchantName ?? '' });
    }

    for (const gem of (item.gems ?? [])) {
      if (gem?.id != null) gem_count++;
    }
  });

  return { trinkets, enchants, gem_count };
}

/**
 * Convert a Midnight-format talent tree (from `encounterRankings`) to the
 * sorted `v2:`-prefixed node-ID key used throughout the application.
 */
export function talentKeyV2(talents: WclTalentTree | undefined): string {
  if (!talents) return '';
  const ids: number[] = [];
  for (const section of [talents.class, talents.spec]) {
    if (!section) continue;
    for (const rowArr of Object.values(section)) {
      for (const entry of (rowArr ?? [])) {
        const nodeId = entry?.node?.nodeId ?? entry?.nodeId;
        if (nodeId != null) ids.push(nodeId);
      }
    }
  }
  return ids.length ? 'v2:' + [...new Set(ids)].sort((a, b) => a - b).join(',') : '';
}
