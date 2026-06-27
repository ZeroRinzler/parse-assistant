import { describe, it, expect } from 'vitest';
import { SPEC_META, classList, specsForClass, specMetaOf, classIconUrl, specIconUrl } from './spec-meta';

/**
 * SPEC_META is the single source for the spec->class split (it replaced the old private
 * `SPEC_TO_WCL` in `wcl-api.ts`). This list pins the supported spec folders; adding/removing a
 * spec must change both.
 */
const EXPECTED_SPECS = [
  'RetributionPaladin', 'HolyPaladin', 'ProtectionPaladin',
  'FireMage', 'ArcaneMage', 'FrostMage',
  'HavocDemonHunter', 'VengeanceDemonHunter',
  'FuryWarrior', 'ArmsWarrior', 'ProtectionWarrior',
  'UnholyDeathKnight', 'FrostDeathKnight', 'BloodDeathKnight',
  'BalanceDruid', 'FeralDruid', 'GuardianDruid', 'RestorationDruid',
  'BeastMasteryHunter', 'MarksmanshipHunter', 'SurvivalHunter',
  'BrewmasterMonk', 'WindwalkerMonk', 'MistweaverMonk',
  'DisciplinePriest', 'HolyPriest', 'ShadowPriest',
  'AssassinationRogue', 'OutlawRogue', 'SubtletyRogue',
  'ElementalShaman', 'EnhancementShaman', 'RestorationShaman',
  'AfflictionWarlock', 'DemonologyWarlock', 'DestructionWarlock',
  'DevastationEvoker', 'PreservationEvoker', 'AugmentationEvoker',
];

const EXPECTED_CLASSES = [
  'DeathKnight', 'DemonHunter', 'Druid', 'Evoker', 'Hunter', 'Mage', 'Monk',
  'Paladin', 'Priest', 'Rogue', 'Shaman', 'Warlock', 'Warrior',
];

describe('SPEC_META', () => {
  it('covers exactly the expected 39 spec folders', () => {
    expect(Object.keys(SPEC_META).sort()).toEqual([...EXPECTED_SPECS].sort());
  });

  it('gives every spec a non-empty class name, spec name, and icon stems', () => {
    for (const meta of Object.values(SPEC_META)) {
      expect(meta.className, meta.spec).not.toBe('');
      expect(meta.specName, meta.spec).not.toBe('');
      expect(meta.classIcon, meta.spec).not.toBe('');
      expect(meta.specIcon, meta.spec).not.toBe('');
    }
  });

  it('keeps the WCL rankings split that wcl-api consumes (className + specName)', () => {
    expect(SPEC_META['BeastMasteryHunter'].className).toBe('Hunter');
    expect(SPEC_META['BeastMasteryHunter'].specName).toBe('BeastMastery');
    expect(SPEC_META['BloodDeathKnight'].className).toBe('DeathKnight');
    expect(SPEC_META['SubtletyRogue'].specName).toBe('Subtlety');
  });

  it('derives the class icon from the lowercased class name', () => {
    expect(SPEC_META['SubtletyRogue'].classIcon).toBe('class_rogue');
    expect(SPEC_META['BloodDeathKnight'].classIcon).toBe('class_deathknight');
  });

  it('derives readable spaced labels', () => {
    expect(SPEC_META['BloodDeathKnight'].classLabel).toBe('Death Knight');
    expect(SPEC_META['BeastMasteryHunter'].specLabel).toBe('Beast Mastery');
    expect(SPEC_META['SubtletyRogue'].specLabel).toBe('Subtlety');
  });
});

describe('classList', () => {
  it('collapses the specs to one entry per class, sorted by label', () => {
    const labels = classList().map(entry => entry.classLabel);
    expect(labels).toEqual([...EXPECTED_CLASSES].map(c => c.replace(/([A-Z])/g, ' $1').trim()).sort());
  });

  it('carries the class icon for each class', () => {
    const rogue = classList().find(entry => entry.className === 'Rogue');
    expect(rogue?.classIcon).toBe('class_rogue');
  });
});

describe('specsForClass', () => {
  it('returns only the available specs for a class, sorted by spec label', () => {
    const available = ['SubtletyRogue', 'OutlawRogue', 'FireMage', 'AssassinationRogue'];
    expect(specsForClass('Rogue', available).map(meta => meta.specLabel)).toEqual(['Assassination', 'Outlaw', 'Subtlety']);
  });

  it('returns nothing when the class has no available specs', () => {
    expect(specsForClass('Rogue', ['FireMage'])).toEqual([]);
  });

  it('ignores unknown folder keys in the available list', () => {
    expect(specsForClass('Rogue', ['NotAReal Spec', 'SubtletyRogue']).map(meta => meta.spec)).toEqual(['SubtletyRogue']);
  });
});

describe('specMetaOf', () => {
  it('looks up a known spec', () => {
    expect(specMetaOf('SubtletyRogue')?.className).toBe('Rogue');
  });

  it('returns undefined for empty or unknown specs', () => {
    expect(specMetaOf('')).toBeUndefined();
    expect(specMetaOf(null)).toBeUndefined();
    expect(specMetaOf('Bogus')).toBeUndefined();
  });
});

describe('icon URL helpers', () => {
  it('builds a class icon URL', () => {
    expect(classIconUrl('Rogue')).toBe('https://wow.zamimg.com/images/wow/icons/small/class_rogue.jpg');
  });

  it('accepts a spaced class name (the player fallback uses subType like "Death Knight")', () => {
    expect(classIconUrl('Death Knight')).toBe('https://wow.zamimg.com/images/wow/icons/small/class_deathknight.jpg');
  });

  it('returns empty for an unknown or missing class name', () => {
    expect(classIconUrl('')).toBe('');
    expect(classIconUrl('Unknown')).toBe('');
  });

  it('builds a spec icon URL from the baked stem', () => {
    expect(specIconUrl('SubtletyRogue')).toBe('https://wow.zamimg.com/images/wow/icons/small/ability_stealth.jpg');
  });

  it('returns empty for an unknown spec', () => {
    expect(specIconUrl('Bogus')).toBe('');
  });
});
