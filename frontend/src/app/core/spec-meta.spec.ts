import { describe, it, expect, beforeEach } from 'vitest';
import {
  hydrateSpecMeta, classList, specsForClass, specMetaOf, classIconUrl, specIconUrl,
} from './spec-meta';

// The spec universe is hydrated at runtime from the WCL-derived spec-meta.json, so these tests
// seed one fixed spec and assert the helpers behave over it.
const SUBTLETY = {
  spec: 'SubtletyRogue', className: 'Rogue', specName: 'Subtlety',
  classLabel: 'Rogue', specLabel: 'Subtlety', classIcon: 'class_rogue', specIcon: 'ability_stealth',
};

beforeEach(() => hydrateSpecMeta([SUBTLETY]));

describe('specMetaOf', () => {
  it('resolves the WCL className/specName the rankings query needs', () => {
    expect(specMetaOf('SubtletyRogue')).toMatchObject({ className: 'Rogue', specName: 'Subtlety' });
  });

  it('returns undefined for empty or unknown specs', () => {
    expect(specMetaOf('')).toBeUndefined();
    expect(specMetaOf(null)).toBeUndefined();
    expect(specMetaOf('Bogus')).toBeUndefined();
  });
});

describe('classList', () => {
  it('lists one entry per class with its label and icon', () => {
    expect(classList()).toEqual([{ className: 'Rogue', classLabel: 'Rogue', classIcon: 'class_rogue' }]);
  });
});

describe('specsForClass', () => {
  it('returns the available specs for a class', () => {
    expect(specsForClass('Rogue', ['SubtletyRogue']).map(meta => meta.spec)).toEqual(['SubtletyRogue']);
  });

  it('ignores unknown or off-class folder keys', () => {
    expect(specsForClass('Rogue', ['Bogus'])).toEqual([]);
    expect(specsForClass('Mage', ['SubtletyRogue'])).toEqual([]);
  });
});

describe('classIconUrl', () => {
  it('builds a class icon URL', () => {
    expect(classIconUrl('Rogue')).toBe('https://wow.zamimg.com/images/wow/icons/small/class_rogue.jpg');
  });

  it('returns empty for an unknown or missing class name', () => {
    expect(classIconUrl('')).toBe('');
    expect(classIconUrl('Unknown')).toBe('');
  });
});

describe('specIconUrl', () => {
  it('builds a spec icon URL from the baked stem', () => {
    expect(specIconUrl('SubtletyRogue')).toBe('https://wow.zamimg.com/images/wow/icons/small/ability_stealth.jpg');
  });

  it('returns empty for an unknown spec', () => {
    expect(specIconUrl('Bogus')).toBe('');
  });
});
