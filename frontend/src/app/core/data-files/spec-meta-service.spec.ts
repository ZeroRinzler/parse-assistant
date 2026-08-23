import { describe, it, expect } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { computed } from '@angular/core';
import { DataFileApiService } from './data-file-api-service';
import { Result, Results } from '../http/result';
import { SpecMetaService, SpecMeta } from './spec-meta-service';

const specMeta = Object.create(SpecMetaService.prototype) as SpecMetaService;

// The spec universe is hydrated at runtime from the WCL-derived spec-meta.json, so these tests seed fixed specs.
const SUBTLETY = {
  spec: 'SubtletyRogue', className: 'Rogue', specName: 'Subtlety',
  classLabel: 'Rogue', specLabel: 'Subtlety', classIcon: 'class_rogue', specIcon: 'ability_stealth',
};

const FROST_MAGE = {
  spec: 'FrostMage', className: 'Mage', specName: 'Frost',
  classLabel: 'Mage', specLabel: 'Frost', classIcon: 'class_mage', specIcon: 'spell_frost_frostbolt02',
};

const UNIVERSE = specMeta.buildUniverse([SUBTLETY]);

function serviceWith(getSpecMeta: () => Promise<Result<SpecMeta[]>>): SpecMetaService {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [{ provide: DataFileApiService, useValue: { getSpecMeta } }],
  });
  return TestBed.inject(SpecMetaService);
}

describe('SpecMetaService', () => {
  it('hydrates itself from the data file on first injection', async () => {
    const service = serviceWith(async () => Results.ok([SUBTLETY]));
    await expect(service.resolve('SubtletyRogue')).resolves.toMatchObject({ className: 'Rogue', specName: 'Subtlety' });
  });

  it('keeps resolve pending until the first hydration lands', async () => {
    const service = serviceWith(() => new Promise(() => undefined));
    const STILL_PENDING = Symbol('still pending');
    const resolving = service.resolve('SubtletyRogue');

    // Racing an already-resolved promise settles on the next microtask, so it wins iff `resolving` has not.
    await expect(Promise.race([resolving, Promise.resolve(STILL_PENDING)])).resolves.toBe(STILL_PENDING);

    service.hydrate([SUBTLETY]);
    await expect(resolving).resolves.toMatchObject({ className: 'Rogue', specName: 'Subtlety' });
  });

  it('resolves undefined for an unknown spec once hydrated', async () => {
    const service = serviceWith(async () => Results.ok([SUBTLETY]));
    await expect(service.resolve('Bogus')).resolves.toBeUndefined();
  });

  it('hydrates the empty universe on a failed fetch, so resolve still settles', async () => {
    const service = serviceWith(async () => Results.transient('spec-meta.json unreachable'));
    await expect(service.resolve('SubtletyRogue')).resolves.toBeUndefined();
  });

  it('recomputes a computed created before a later hydration replaces the universe', async () => {
    const service = serviceWith(async () => Results.ok([SUBTLETY]));
    await service.resolve('');
    const classCount = computed(() => service.classList().length);
    expect(classCount()).toBe(1);
    service.hydrate([SUBTLETY, FROST_MAGE]);
    expect(classCount()).toBe(2);
  });
});

describe('specMetaOf', () => {
  it('resolves the WCL className/specName the rankings query needs', () => {
    expect(specMeta.specMetaOf(UNIVERSE, 'SubtletyRogue')).toMatchObject({ className: 'Rogue', specName: 'Subtlety' });
  });

  it('returns undefined for empty or unknown specs', () => {
    expect(specMeta.specMetaOf(UNIVERSE, '')).toBeUndefined();
    expect(specMeta.specMetaOf(UNIVERSE, null)).toBeUndefined();
    expect(specMeta.specMetaOf(UNIVERSE, 'Bogus')).toBeUndefined();
  });
});

describe('classList', () => {
  it('lists one entry per class with its label and icon', () => {
    expect(specMeta['classListOf'](UNIVERSE)).toEqual([{ className: 'Rogue', classLabel: 'Rogue', classIcon: 'class_rogue' }]);
  });
});

describe('specsForClass', () => {
  it('returns the available specs for a class', () => {
    expect(specMeta['specsForClassOf'](UNIVERSE, 'Rogue', ['SubtletyRogue']).map(meta => meta.spec)).toEqual(['SubtletyRogue']);
  });

  it('ignores unknown or off-class folder keys', () => {
    expect(specMeta['specsForClassOf'](UNIVERSE, 'Rogue', ['Bogus'])).toEqual([]);
    expect(specMeta['specsForClassOf'](UNIVERSE, 'Mage', ['SubtletyRogue'])).toEqual([]);
  });
});

describe('classIconUrl', () => {
  it('builds a class icon URL', () => {
    expect(specMeta['classIconUrlOf'](UNIVERSE, 'Rogue')).toBe('https://wow.zamimg.com/images/wow/icons/small/class_rogue.jpg');
  });

  it('returns empty for an unknown or missing class name', () => {
    expect(specMeta['classIconUrlOf'](UNIVERSE, '')).toBe('');
    expect(specMeta['classIconUrlOf'](UNIVERSE, 'Unknown')).toBe('');
  });
});

describe('specIconUrl', () => {
  it('builds a spec icon URL from the baked stem', () => {
    expect(specMeta['specIconUrlOf'](UNIVERSE, 'SubtletyRogue')).toBe('https://wow.zamimg.com/images/wow/icons/small/ability_stealth.jpg');
  });

  it('returns empty for an unknown spec', () => {
    expect(specMeta['specIconUrlOf'](UNIVERSE, 'Bogus')).toBe('');
  });
});
