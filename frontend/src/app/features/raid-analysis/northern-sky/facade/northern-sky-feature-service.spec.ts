import { describe, it, expect } from 'vitest';
import { Results } from '../../../../core/http/result';
import { SHADOW_BLADES, SHADOW_DANCE, EVASION } from '../../../../../testing/spell-ids';
import { sliceService } from '../../../../../testing/service-harness';
import { NORTHERN_SKY_DATA_SOURCE, NorthernSkyAbility } from '../data-access/northern-sky-data-source';
import { NorthernSkyFeatureService } from './northern-sky-feature-service';
import { NORTHERN_SKY_ENCOUNTER_ID, NORTHERN_SKY_SPEC, bench } from './northern-sky-harness';
import { TestBed } from '@angular/core/testing';
import { WCL_TRANSPORT } from '../../../../core/wcl/wcl-transport';
import { DATA_FILE_TRANSPORT } from '../../../../core/data-files/data-file-transport';

TestBed.configureTestingModule({ providers: [
  { provide: WCL_TRANSPORT, useValue: {} },
  { provide: DATA_FILE_TRANSPORT, useValue: { readJson: () => new Promise(() => undefined) } },
  { provide: NORTHERN_SKY_DATA_SOURCE, useValue: {} },
] });
const svc = TestBed.inject(NorthernSkyFeatureService);
TestBed.resetTestingModule();

function ability(spell_id: number, kind: NorthernSkyAbility['kind'], cast_times_s: number[]): NorthernSkyAbility {
  return { spell_id, name: `n${spell_id}`, icon: '', kind, cast_times_s };
}

const HEADER = `EncounterID:${NORTHERN_SKY_ENCOUNTER_ID};Name:Boss;Difficulty:Mythic`;

describe('buildNorthernSkyNote', () => {
  it('emits the Mythic header alone when nothing is selected', () => {
    const model = bench({ abilities: [{ spell_id: SHADOW_BLADES, name: 'Shadow Blades', icon: '', kind: 'cooldown', cast_times_s: [10] }] });
    expect(svc.buildNorthernSkyNote(model, new Set())).toBe(HEADER);
  });

  it('emits one line per cast time, tagged everyone, with no phase field', () => {
    const model = bench({ abilities: [{ spell_id: SHADOW_BLADES, name: 'Shadow Blades', icon: '', kind: 'cooldown', cast_times_s: [10, 40] }] });
    expect(svc.buildNorthernSkyNote(model, new Set([SHADOW_BLADES]))).toBe([
      HEADER,
      `time:10;tag:everyone;spellid:${SHADOW_BLADES};text:Shadow Blades`,
      `time:40;tag:everyone;spellid:${SHADOW_BLADES};text:Shadow Blades`,
    ].join('\n'));
  });

  it('interleaves a cooldown and a defensive in chronological order', () => {
    const model = bench({ abilities: [
      { spell_id: SHADOW_BLADES, name: 'Shadow Blades', icon: '', kind: 'cooldown', cast_times_s: [40] },
      { spell_id: SHADOW_DANCE, name: 'Evasion', icon: '', kind: 'defensive', cast_times_s: [10] },
    ] });
    expect(svc.buildNorthernSkyNote(model, new Set([SHADOW_BLADES, SHADOW_DANCE]))).toBe([
      HEADER,
      `time:10;tag:everyone;spellid:${SHADOW_DANCE};text:Evasion`,
      `time:40;tag:everyone;spellid:${SHADOW_BLADES};text:Shadow Blades`,
    ].join('\n'));
  });

  it('omits a deselected ability', () => {
    const model = bench({ abilities: [
      { spell_id: SHADOW_BLADES, name: 'Shadow Blades', icon: '', kind: 'cooldown', cast_times_s: [10] },
      { spell_id: SHADOW_DANCE, name: 'Shadow Dance', icon: '', kind: 'cooldown', cast_times_s: [20] },
    ] });
    expect(svc.buildNorthernSkyNote(model, new Set([SHADOW_BLADES]))).toBe([
      HEADER,
      `time:10;tag:everyone;spellid:${SHADOW_BLADES};text:Shadow Blades`,
    ].join('\n'));
  });

  it('emits the header alone for a bench with no abilities', () => {
    expect(svc.buildNorthernSkyNote(bench(), new Set())).toBe(HEADER);
  });

  it('emits no line for a selected ability that has no cast times', () => {
    expect(svc.buildNorthernSkyNote(bench({ abilities: [ability(SHADOW_BLADES, 'cooldown', [])] }), new Set([SHADOW_BLADES]))).toBe(HEADER);
  });
});

describe('abilitiesByKind', () => {
  it('splits abilities into cooldowns and defensives, preserving order', () => {
    const cd1 = ability(SHADOW_BLADES, 'cooldown', [10]);
    const def = ability(EVASION, 'defensive', [20]);
    const cd2 = ability(SHADOW_DANCE, 'cooldown', [30]);
    expect(svc.abilitiesByKind([cd1, def, cd2])).toEqual({ cooldowns: [cd1, cd2], defensives: [def] });
  });
});

describe('selectedIds', () => {
  it('includes every ability the user has not excluded (a new ability defaults on)', () => {
    const abilities = [ability(SHADOW_BLADES, 'cooldown', [10]), ability(SHADOW_DANCE, 'cooldown', [20])];
    expect(svc.selectedIds(abilities, new Set([SHADOW_DANCE]))).toEqual(new Set([SHADOW_BLADES]));
  });
});

describe('isAllSelected', () => {
  const abilities = [ability(SHADOW_BLADES, 'cooldown', [10]), ability(SHADOW_DANCE, 'cooldown', [20])];
  it('is true when nothing is excluded', () => { expect(svc.isAllSelected(abilities, new Set())).toBe(true); });
  it('is false when any ability is excluded', () => { expect(svc.isAllSelected(abilities, new Set([SHADOW_DANCE]))).toBe(false); });
  it('is false for an empty list', () => { expect(svc.isAllSelected([], new Set())).toBe(false); });
});

describe('toggleExclusion', () => {
  it('unchecking adds the id to the exclusion set', () => {
    expect(svc.toggleExclusion(new Set(), SHADOW_BLADES, false)).toEqual(new Set([SHADOW_BLADES]));
  });

  it('checking removes the id from the exclusion set', () => {
    expect(svc.toggleExclusion(new Set([SHADOW_BLADES]), SHADOW_BLADES, true)).toEqual(new Set());
  });

  it('does not mutate the input set', () => {
    const original = new Set([SHADOW_BLADES]);
    svc.toggleExclusion(original, SHADOW_DANCE, false);
    expect(original).toEqual(new Set([SHADOW_BLADES]));
  });
});

describe('toggleAllExclusion', () => {
  const abilities = [ability(SHADOW_BLADES, 'cooldown', [10]), ability(SHADOW_DANCE, 'cooldown', [20])];

  it('excludes every ability when all are currently selected', () => {
    expect(svc.toggleAllExclusion(abilities, new Set())).toEqual(new Set([SHADOW_BLADES, SHADOW_DANCE]));
  });

  it('clears all exclusions when some are currently deselected', () => {
    expect(svc.toggleAllExclusion(abilities, new Set([SHADOW_BLADES]))).toEqual(new Set());
  });

  it('leaves persisted exclusions untouched over an empty ability list', () => {
    const excluded = new Set([SHADOW_BLADES, EVASION]);
    expect(svc.toggleAllExclusion([], excluded)).toEqual(excluded);
  });
});

describe('isPanelOpen', () => {
  it('is open once requested while the bench has abilities to export', () => {
    expect(svc.isPanelOpen(true, true)).toBe(true);
  });

  it('closes an already-open panel once the bench has nothing to export', () => {
    expect(svc.isPanelOpen(true, false)).toBe(false);
  });

  it('stays closed when not requested even if the bench has abilities', () => {
    expect(svc.isPanelOpen(false, true)).toBe(false);
  });
});

describe('NorthernSkyFeatureService', () => {
  it('returns the bench from its data source', async () => {
    const model = bench({ abilities: [{ spell_id: SHADOW_BLADES, name: 'Shadow Blades', icon: '', kind: 'cooldown', cast_times_s: [10] }] });
    const service = sliceService(NORTHERN_SKY_DATA_SOURCE, NorthernSkyFeatureService, Results.ok(model));
    expect(await service.getExport(NORTHERN_SKY_SPEC, NORTHERN_SKY_ENCOUNTER_ID)).toEqual(Results.ok(model));
  });

  it('propagates a missing bench so the export waiting state shows', async () => {
    const service = sliceService(NORTHERN_SKY_DATA_SOURCE, NorthernSkyFeatureService, Results.missing('Not yet ingested.'));
    expect(await service.getExport(NORTHERN_SKY_SPEC, NORTHERN_SKY_ENCOUNTER_ID)).toEqual(Results.missing('Not yet ingested.'));
  });
});
