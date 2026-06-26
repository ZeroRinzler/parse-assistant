import { describe, it, expect } from 'vitest';
import { talentKeyFromTree, decodeHtmlEntities, iconFile, buildSpecMap, extractGear } from './wcl-mappers';

describe('talentKeyFromTree', () => {
  it('returns empty string for undefined input', () => {
    expect(talentKeyFromTree(undefined)).toBe('');
  });

  it('returns empty string for empty array', () => {
    expect(talentKeyFromTree([])).toBe('');
  });

  it('builds a v2: key from nodeIDs in string-sorted order', () => {
    const tree = [{ nodeID: 90640 }, { nodeID: 90692 }, { nodeID: 90638 }];
    expect(talentKeyFromTree(tree)).toBe('v2:90638,90640,90692');
  });

  it('includes duplicate nodeIDs (no dedup - matches ingest)', () => {
    const tree = [{ nodeID: 110416 }, { nodeID: 110416 }, { nodeID: 110416 }, { nodeID: 90638 }];
    // string sort: '110416' < '90638' because '1' < '9'
    expect(talentKeyFromTree(tree)).toBe('v2:110416,110416,110416,90638');
  });

  it('skips entries with null/undefined nodeID', () => {
    const tree = [{ nodeID: 90640 }, { nodeID: undefined }, { nodeID: 90692 }];
    expect(talentKeyFromTree(tree)).toBe('v2:90640,90692');
  });
});

describe('decodeHtmlEntities', () => {
  it('decodes &amp; to &', () => {
    expect(decodeHtmlEntities('+41 Intellect &amp; +115 Stamina')).toBe('+41 Intellect & +115 Stamina');
  });

  it('decodes multiple entity types', () => {
    expect(decodeHtmlEntities('&lt;b&gt;test&lt;/b&gt;')).toBe('<b>test</b>');
  });

  it('leaves plain text unchanged', () => {
    expect(decodeHtmlEntities('Gaze of the Alnseer')).toBe('Gaze of the Alnseer');
  });
});

describe('iconFile', () => {
  it('returns empty string for undefined', () => {
    expect(iconFile(undefined)).toBe('');
  });

  it('strips lowercase .jpg extension', () => {
    expect(iconFile('inv_sword_01.jpg')).toBe('inv_sword_01');
  });

  it('strips uppercase .JPG extension (case insensitive)', () => {
    expect(iconFile('INV_SWORD.JPG')).toBe('INV_SWORD');
  });

  it('leaves a name with no extension unchanged', () => {
    expect(iconFile('inv_sword_01')).toBe('inv_sword_01');
  });

  it('does not strip .jpeg (only .jpg is removed)', () => {
    expect(iconFile('inv_icon.jpeg')).toBe('inv_icon.jpeg');
  });
});

describe('buildSpecMap', () => {
  it('maps player id to spec+class with spaces removed, for dps role', () => {
    const groups = {
      dps: [{ id: 1, type: 'Rogue', name: 'Zug', specs: [{ spec: 'Subtlety' }] }],
    };
    const map = buildSpecMap(groups);
    expect(map[1]).toBe('SubtletyRogue');
  });

  it('iterates all roles: dps, healers, tanks', () => {
    const groups = {
      dps:     [{ id: 1, type: 'Rogue',   name: 'A', specs: [{ spec: 'Subtlety' }] }],
      healers: [{ id: 2, type: 'Paladin', name: 'B', specs: [{ spec: 'Holy'     }] }],
      tanks:   [{ id: 3, type: 'Warrior', name: 'C', specs: [{ spec: 'Protection' }] }],
    };
    const map = buildSpecMap(groups);
    expect(map[1]).toBe('SubtletyRogue');
    expect(map[2]).toBe('HolyPaladin');
    expect(map[3]).toBe('ProtectionWarrior');
  });

  it('removes spaces from class name (e.g. "Death Knight" -> "DeathKnight")', () => {
    const groups = {
      dps: [{ id: 4, type: 'Death Knight', name: 'X', specs: [{ spec: 'Frost' }] }],
    };
    expect(buildSpecMap(groups)[4]).toBe('FrostDeathKnight');
  });

  it('populates name_<id> entries for every player with a name', () => {
    const groups = {
      dps: [{ id: 10, type: 'Rogue', name: 'Thrall', specs: [{ spec: 'Subtlety' }] }],
    };
    expect(buildSpecMap(groups)['name_10']).toBe('Thrall');
  });

  it('skips the numeric id key when specs array is empty', () => {
    const groups = { dps: [{ id: 5, type: 'Rogue', name: 'Y', specs: [] }] };
    const map = buildSpecMap(groups);
    expect(map[5]).toBeUndefined();
    expect(map['name_5']).toBe('Y');
  });

  it('skips the numeric id key when type is missing', () => {
    const groups = { dps: [{ id: 6, type: '', name: 'Z', specs: [{ spec: 'Fury' }] }] };
    const map = buildSpecMap(groups);
    expect(map[6]).toBeUndefined();
  });

  it('handles an empty groups object gracefully', () => {
    expect(buildSpecMap({})).toEqual({});
  });
});

describe('extractGear', () => {
  // Builds a WclRankEntry with a sparse gear array of the given length.
  // Individual slots can be set on the returned array before passing to extractGear.
  const gearEntry = (slots: unknown[]) => ({ gear: slots } as unknown as Parameters<typeof extractGear>[0]);

  it('extracts trinkets from slots 12 and 13 only', () => {
    const gear: unknown[] = Array(14).fill(null);
    gear[12] = { id: 200, name: 'Trinket A', icon: 'a.jpg' };
    gear[13] = { id: 201, name: 'Trinket B', icon: 'b.jpg' };
    const { trinkets } = extractGear(gearEntry(gear));
    expect(trinkets).toHaveLength(2);
    expect(trinkets[0]).toMatchObject({ slot: 12, id: 200, name: 'Trinket A', icon: 'a' });
    expect(trinkets[1]).toMatchObject({ slot: 13, id: 201, name: 'Trinket B', icon: 'b' });
  });

  it('applies iconFile to strip .jpg from trinket icons', () => {
    const gear: unknown[] = Array(14).fill(null);
    gear[12] = { id: 1, name: 'X', icon: 'inv_trinket.jpg' };
    const { trinkets } = extractGear(gearEntry(gear));
    expect(trinkets[0].icon).toBe('inv_trinket');
  });

  it('extracts enchants from any slot with permanentEnchant (number)', () => {
    const { enchants } = extractGear(gearEntry([{ id: 1, name: 'Ring', permanentEnchant: 5678 }]));
    expect(enchants).toHaveLength(1);
    expect(enchants[0]).toMatchObject({ slot: 0, id: 5678 });
  });

  it('parses string permanentEnchant IDs via parseInt', () => {
    const { enchants } = extractGear(gearEntry([{ id: 1, name: 'Ring', permanentEnchant: '9999' }]));
    expect(enchants[0].id).toBe(9999);
  });

  it('skips items with null id', () => {
    const gear: unknown[] = Array(14).fill(null);
    gear[12] = { id: null, name: 'ghost', icon: 'x.jpg' };
    const { trinkets, enchants } = extractGear(gearEntry(gear));
    expect(trinkets).toHaveLength(0);
    expect(enchants).toHaveLength(0);
  });

  it('returns empty arrays for an empty gear list', () => {
    expect(extractGear(gearEntry([]))).toEqual({ trinkets: [], enchants: [] });
  });

  it('does not include a non-trinket slot without enchant in any list', () => {
    const gear: unknown[] = Array(15).fill(null);
    gear[14] = { id: 100, name: 'Cloak' }; // slot 14 = cloak, no enchant
    const { trinkets, enchants } = extractGear(gearEntry(gear));
    expect(trinkets).toHaveLength(0);
    expect(enchants).toHaveLength(0);
  });
});
