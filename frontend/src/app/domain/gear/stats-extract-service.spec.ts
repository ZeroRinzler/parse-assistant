import { describe, it, expect } from 'vitest';
import { WclCombatantInfo, WclGearItem } from '../../core/wcl/wcl.models';
import { StatsExtractService } from './stats-extract-service';
import { TestBed } from '@angular/core/testing';

const statsExtract = TestBed.inject(StatsExtractService);

describe('extractStats', () => {
  it('takes the max of strength/agility/intellect as the primary stat and reads the rest flat off the event', () => {
    const event: WclCombatantInfo = {
      strength: 378, agility: 2402, intellect: 524, stamina: 34304,
      critMelee: 940, hasteMelee: 938, mastery: 674, versatilityDamageDone: 216,
      avoidance: 58, leech: 221, speed: 70,
    };
    expect(statsExtract.extractStats(event)).toEqual({
      primary: 2402, stamina: 34304, crit: 940, haste: 938, mastery: 674,
      versatility: 216, avoidance: 58, leech: 221, speed: 70,
    });
  });

  it('defaults every absent field to 0', () => {
    expect(statsExtract.extractStats({})).toEqual({
      primary: 0, stamina: 0, crit: 0, haste: 0, mastery: 0, versatility: 0, avoidance: 0, leech: 0, speed: 0,
    });
  });
});

describe('averageItemLevel', () => {
  it('averages itemLevel over equipped slots, excluding vacant ones (itemLevel 0) and cosmetic ones (itemLevel 1, e.g. Shirt)', () => {
    const gear: WclGearItem[] = [{ itemLevel: 300 }, { itemLevel: 200 }, { itemLevel: 0 }, { itemLevel: 1 }];
    expect(statsExtract.averageItemLevel(gear)).toBe(250);
  });

  it('keeps a real itemLevel of 2, the boundary just above the excluded cosmetic value', () => {
    const gear: WclGearItem[] = [{ itemLevel: 300 }, { itemLevel: 2 }];
    expect(statsExtract.averageItemLevel(gear)).toBe(151);
  });

  it('is undefined for no equipped items or an absent gear array', () => {
    expect(statsExtract.averageItemLevel([{ itemLevel: 0 }, { itemLevel: 1 }])).toBeUndefined();
    expect(statsExtract.averageItemLevel(undefined)).toBeUndefined();
  });
});
