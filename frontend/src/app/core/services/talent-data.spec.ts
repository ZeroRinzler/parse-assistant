import { assert, describe, it, expect, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { missing, transient } from '../result';
import { TalentDataService, indexTalentTrees } from './talent-data';

const DUMP_URL = 'https://www.raidbots.com/static/data/live/talents.json';
const DUMP_REPRO_ID = 'talent-data.dump';
const HTTP_FORBIDDEN = 403;

const SUBTLETY_TREE = {
  className: 'Rogue', specName: 'Subtlety',
  classNodes: [{ entries: [{ id: 11, name: 'Blind', icon: 'spell_blind', spellId: 2094 }] }],
  specNodes: [{ entries: [
    { id: 22, name: 'Find Weakness', icon: 'ability_findweakness', spellId: 91023 },
    { id: 23, name: 'Improved Ambush', icon: 'ability_ambush', spellId: 381620 },
  ] }],
  heroNodes: [{ entries: [{ id: 33, name: 'Fatebound', icon: 'coin', spellId: 452554 }] }],
  subTreeNodes: [{ entries: [{ id: 44, name: 'Trickster' }, {}] }],
};

function setup(): { service: TalentDataService; httpMock: HttpTestingController } {
  TestBed.configureTestingModule({
    providers: [TalentDataService, provideHttpClient(), provideHttpClientTesting()],
  });
  return {
    service: TestBed.inject(TalentDataService),
    httpMock: TestBed.inject(HttpTestingController),
  };
}

describe('indexTalentTrees', () => {
  it('keys each spec by {SpecName}{ClassName} across every node bucket', () => {
    const bySpec = indexTalentTrees([SUBTLETY_TREE]);
    expect([...bySpec.keys()]).toEqual(['SubtletyRogue']);
    const subtletyTalents = bySpec.get('SubtletyRogue');
    assert.exists(subtletyTalents);
    expect(subtletyTalents[22]).toEqual(
      { name: 'Find Weakness', icon: 'ability_findweakness', spellId: 91023 });
  });

  it('carries a hero-tree pick with no spell id and skips an entry with no id', () => {
    const talents = indexTalentTrees([SUBTLETY_TREE]).get('SubtletyRogue');
    assert.exists(talents);
    expect(talents[44]).toEqual({ name: 'Trickster', icon: '' });
    expect(Object.keys(talents)).toEqual(['11', '22', '23', '33', '44']);
  });
});

describe('TalentDataService', () => {
  afterEach(() => { TestBed.inject(HttpTestingController).verify(); });

  it('resolves a spec from the dump', async () => {
    const { service, httpMock } = setup();
    const pending = service.getTalents('SubtletyRogue');
    httpMock.expectOne(DUMP_URL).flush([SUBTLETY_TREE]);
    const result = await pending;
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value[11]).toEqual({ name: 'Blind', icon: 'spell_blind', spellId: 2094 });
  });

  it('is missing for a spec the dump does not carry, the load itself having succeeded', async () => {
    const { service, httpMock } = setup();
    const pending = service.getTalents('BalanceDruid');
    httpMock.expectOne(DUMP_URL).flush([SUBTLETY_TREE]);
    expect(await pending).toEqual(missing('No talent data for this spec.'));
  });

  it('is transient when the dump is unreachable', async () => {
    const { service, httpMock } = setup();
    const failed = service.getTalents('SubtletyRogue');
    httpMock.expectOne(DUMP_URL).error(new ProgressEvent('error'));
    expect(await failed).toEqual(transient('WCL is unreachable right now.'));
  });

  it('is permanent when Raidbots refuses the dump', async () => {
    const { service, httpMock } = setup();
    const failed = service.getTalents('SubtletyRogue');
    httpMock.expectOne(DUMP_URL).flush('nope', { status: HTTP_FORBIDDEN, statusText: 'Forbidden' });
    const result = await failed;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatchObject({ kind: 'permanent', id: DUMP_REPRO_ID });
  });

  it('is permanent when the dump answers 200 with a body that is not a tree list', async () => {
    const { service, httpMock } = setup();
    const failed = service.getTalents('SubtletyRogue');
    httpMock.expectOne(DUMP_URL).flush({ error: 'maintenance' });
    const result = await failed;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatchObject({ kind: 'permanent', id: DUMP_REPRO_ID });
  });
});
