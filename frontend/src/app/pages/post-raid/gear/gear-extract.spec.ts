import { describe, it, expect } from 'vitest';
import { WclCombatantInfo, WclGearItem } from '../../../core/models/wcl.models';
import { TRINKET_SLOTS, iconFile, decodeHtmlEntities, extractGear, selectCombatantInfo } from './gear-extract';

// Named gear fixtures (no raw ids in assertions). Trinket slots are the WCL
// quirk indices 12/13; an enchant can sit on any slot - 15 is Main Hand.
const TRINKET_1_SLOT = 12;
const TRINKET_2_SLOT = 13;
const NON_TRINKET_SLOT = 5;
const ENCHANTED_SLOT = 15;
const TRINKET_A_ID = 200;
const TRINKET_B_ID = 201;
const ENCHANT_ID = 8041;

describe('TRINKET_SLOTS', () => {
  it('is the two WCL trinket slot indices, in slot order', () => {
    expect([...TRINKET_SLOTS]).toEqual([TRINKET_1_SLOT, TRINKET_2_SLOT]);
  });
});

describe('iconFile', () => {
  it('strips a trailing .jpg (case-insensitive)', () => {
    expect(iconFile('inv_trinket.jpg')).toBe('inv_trinket');
    expect(iconFile('inv_trinket.JPG')).toBe('inv_trinket');
  });

  it('returns empty for an absent icon and leaves a non-.jpg name untouched', () => {
    expect(iconFile(undefined)).toBe('');
    expect(iconFile('inv_trinket')).toBe('inv_trinket');
  });
});

describe('decodeHtmlEntities', () => {
  it('decodes the five WCL gameData entities', () => {
    expect(decodeHtmlEntities('A &amp; B &lt;x&gt; &quot;q&quot; &#39;s')).toBe('A & B <x> "q" \'s');
  });

  it('leaves a string with no entities unchanged', () => {
    expect(decodeHtmlEntities('Sophic Devotion')).toBe('Sophic Devotion');
  });
});

describe('extractGear', () => {
  it('extracts trinkets from slots 12/13 (stripping .jpg, coercing string ids) and enchants from any slot', () => {
    const gear: WclGearItem[] = Array(16).fill(null);
    gear[TRINKET_1_SLOT] = { id: TRINKET_A_ID, name: 'Trinket A', icon: 'a.jpg' };
    gear[TRINKET_2_SLOT] = { id: String(TRINKET_B_ID), name: 'Trinket B', icon: 'b.jpg' };
    gear[ENCHANTED_SLOT] = { id: 1, name: 'Wep', permanentEnchant: String(ENCHANT_ID) };

    const { trinkets, enchants } = extractGear(gear);

    expect(trinkets).toEqual([
      { slot: TRINKET_1_SLOT, id: TRINKET_A_ID, name: 'Trinket A', icon: 'a' },
      { slot: TRINKET_2_SLOT, id: TRINKET_B_ID, name: 'Trinket B', icon: 'b' },
    ]);
    expect(enchants).toEqual([{ slot: ENCHANTED_SLOT, id: ENCHANT_ID, name: '' }]);
  });

  it('ignores items in non-trinket slots for the trinket list', () => {
    const gear: WclGearItem[] = Array(16).fill(null);
    gear[NON_TRINKET_SLOT] = { id: TRINKET_A_ID, name: 'Ring', icon: 'r.jpg' };

    expect(extractGear(gear).trinkets).toEqual([]);
  });

  it('skips items with no id and returns empty for an absent gear array', () => {
    const gear: WclGearItem[] = Array(16).fill(null);
    gear[TRINKET_1_SLOT] = { name: 'No id', icon: 'x.jpg' };

    expect(extractGear(gear).trinkets).toEqual([]);
    expect(extractGear(undefined)).toEqual({ trinkets: [], enchants: [] });
  });
});

describe('selectCombatantInfo', () => {
  const PLAYER_ID = 10;
  const OTHER_ID = 20;
  const forPlayer = (sourceID: number): WclCombatantInfo => ({ sourceID, gear: [] });

  it('picks the event matching the player sourceID', () => {
    const events = [forPlayer(OTHER_ID), forPlayer(PLAYER_ID)];
    expect(selectCombatantInfo(events, PLAYER_ID)).toBe(events[1]);
  });

  it('falls back to the first event when none matches the player', () => {
    const events = [forPlayer(OTHER_ID)];
    expect(selectCombatantInfo(events, PLAYER_ID)).toBe(events[0]);
  });

  it('returns null for an empty events array', () => {
    expect(selectCombatantInfo([], PLAYER_ID)).toBeNull();
  });
});
