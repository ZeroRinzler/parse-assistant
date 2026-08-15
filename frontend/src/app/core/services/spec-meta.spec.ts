import { describe, it, expect } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { computed } from '@angular/core';
import { DataFileApiService } from './data-file-api';
import { Result, ok, transient } from '../result';
import {
  SpecMetaService, SpecMeta,
  buildUniverse, classList, specsForClass, specMetaOf, classIconUrl, specIconUrl,
} from './spec-meta';

// The spec universe is hydrated at runtime from the WCL-derived spec-meta.json, so these tests seed fixed specs.
const SUBTLETY = {
  spec: 'SubtletyRogue', className: 'Rogue', specName: 'Subtlety',
  classLabel: 'Rogue', specLabel: 'Subtlety', classIcon: 'class_rogue', specIcon: 'ability_stealth',
};

const FROST_MAGE = {
  spec: 'FrostMage', className: 'Mage', specName: 'Frost',
  classLabel: 'Mage', specLabel: 'Frost', classIcon: 'class_mage', specIcon: 'spell_frost_frostbolt02',
};

const UNIVERSE = buildUniverse([SUBTLETY]);

function serviceWith(getSpecMeta: () => Promise<Result<SpecMeta[]>>): SpecMetaService {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [{ provide: DataFileApiService, useValue: { getSpecMeta } }],
  });
  return TestBed.inject(SpecMetaService);
}

const microtask = () => new Promise(resolve => setTimeout(resolve));

describe('SpecMetaService', () => {
  it('hydrates itself from the data file on first injection', async () => {
    const service = serviceWith(async () => ok([SUBTLETY]));
    await expect(service.resolve('SubtletyRogue')).resolves.toMatchObject({ className: 'Rogue', specName: 'Subtlety' });
  });

  it('keeps resolve pending until the first hydration lands', async () => {
    const service = serviceWith(() => new Promise(() => undefined));
    let resolved: unknown = 'pending';
    void service.resolve('SubtletyRogue').then(meta => { resolved = meta; });
    await microtask();
    expect(resolved).toBe('pending');
    service.hydrate([SUBTLETY]);
    await microtask();
    expect(resolved).toMatchObject({ className: 'Rogue', specName: 'Subtlety' });
  });

  it('resolves undefined for an unknown spec once hydrated', async () => {
    const service = serviceWith(async () => ok([SUBTLETY]));
    await expect(service.resolve('Bogus')).resolves.toBeUndefined();
  });

  it('hydrates the empty universe on a failed fetch, so resolve still settles', async () => {
    const service = serviceWith(async () => transient('spec-meta.json unreachable'));
    await expect(service.resolve('SubtletyRogue')).resolves.toBeUndefined();
  });

  it('recomputes a computed created before a later hydration replaces the universe', async () => {
    const service = serviceWith(async () => ok([SUBTLETY]));
    await service.resolve('');
    const classCount = computed(() => service.classList().length);
    expect(classCount()).toBe(1);
    service.hydrate([SUBTLETY, FROST_MAGE]);
    expect(classCount()).toBe(2);
  });
});

describe('specMetaOf', () => {
  it('resolves the WCL className/specName the rankings query needs', () => {
    expect(specMetaOf(UNIVERSE, 'SubtletyRogue')).toMatchObject({ className: 'Rogue', specName: 'Subtlety' });
  });

  it('returns undefined for empty or unknown specs', () => {
    expect(specMetaOf(UNIVERSE, '')).toBeUndefined();
    expect(specMetaOf(UNIVERSE, null)).toBeUndefined();
    expect(specMetaOf(UNIVERSE, 'Bogus')).toBeUndefined();
  });
});

describe('classList', () => {
  it('lists one entry per class with its label and icon', () => {
    expect(classList(UNIVERSE)).toEqual([{ className: 'Rogue', classLabel: 'Rogue', classIcon: 'class_rogue' }]);
  });
});

describe('specsForClass', () => {
  it('returns the available specs for a class', () => {
    expect(specsForClass(UNIVERSE, 'Rogue', ['SubtletyRogue']).map(meta => meta.spec)).toEqual(['SubtletyRogue']);
  });

  it('ignores unknown or off-class folder keys', () => {
    expect(specsForClass(UNIVERSE, 'Rogue', ['Bogus'])).toEqual([]);
    expect(specsForClass(UNIVERSE, 'Mage', ['SubtletyRogue'])).toEqual([]);
  });
});

describe('classIconUrl', () => {
  it('builds a class icon URL', () => {
    expect(classIconUrl(UNIVERSE, 'Rogue')).toBe('https://wow.zamimg.com/images/wow/icons/small/class_rogue.jpg');
  });

  it('returns empty for an unknown or missing class name', () => {
    expect(classIconUrl(UNIVERSE, '')).toBe('');
    expect(classIconUrl(UNIVERSE, 'Unknown')).toBe('');
  });
});

describe('specIconUrl', () => {
  it('builds a spec icon URL from the baked stem', () => {
    expect(specIconUrl(UNIVERSE, 'SubtletyRogue')).toBe('https://wow.zamimg.com/images/wow/icons/small/ability_stealth.jpg');
  });

  it('returns empty for an unknown spec', () => {
    expect(specIconUrl(UNIVERSE, 'Bogus')).toBe('');
  });
});
