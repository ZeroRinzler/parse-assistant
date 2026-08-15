import { describe, it, expect } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { ok, missing, transient } from '../../../core/result';
import { SHADOW_BLADES, SHADOW_DANCE, EVASION } from '../../../../testing/spell-ids';
import { NORTHERN_SKY_DATA_SOURCE, NorthernSkyBench, NorthernSkyAbility } from './northern-sky-data-source';
import {
  NorthernSkyFeatureService, buildNorthernSkyNote, abilitiesByKind, selectedIds, isAllSelected,
  toggleExclusion, toggleAllExclusion, isPanelOpen,
} from './northern-sky.service';

const ENCOUNTER_ID = 3009;

function bench(over: Partial<NorthernSkyBench> = {}): NorthernSkyBench {
  return {
    spec: 'SubtletyRogue', encounter_id: ENCOUNTER_ID, encounter_name: 'Boss',
    abilities: [], ...over,
  };
}

function ability(spell_id: number, kind: NorthernSkyAbility['kind'], cast_times_s: number[]): NorthernSkyAbility {
  return { spell_id, name: `n${spell_id}`, icon: '', kind, cast_times_s };
}

const HEADER = `EncounterID:${ENCOUNTER_ID};Name:Boss;Difficulty:Mythic`;

describe('buildNorthernSkyNote', () => {
  it('emits the Mythic header alone when nothing is selected', () => {
    const model = bench({ abilities: [{ spell_id: SHADOW_BLADES, name: 'Shadow Blades', icon: '', kind: 'cooldown', cast_times_s: [10] }] });
    expect(buildNorthernSkyNote(model, new Set())).toBe(HEADER);
  });

  it('emits one line per cast time, tagged everyone, with no phase field', () => {
    const model = bench({ abilities: [{ spell_id: SHADOW_BLADES, name: 'Shadow Blades', icon: '', kind: 'cooldown', cast_times_s: [10, 40] }] });
    expect(buildNorthernSkyNote(model, new Set([SHADOW_BLADES]))).toBe([
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
    expect(buildNorthernSkyNote(model, new Set([SHADOW_BLADES, SHADOW_DANCE]))).toBe([
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
    expect(buildNorthernSkyNote(model, new Set([SHADOW_BLADES]))).toBe([
      HEADER,
      `time:10;tag:everyone;spellid:${SHADOW_BLADES};text:Shadow Blades`,
    ].join('\n'));
  });

  it('emits the header alone for a bench with no abilities', () => {
    expect(buildNorthernSkyNote(bench(), new Set())).toBe(HEADER);
  });

  it('emits no line for a selected ability that has no cast times', () => {
    expect(buildNorthernSkyNote(bench({ abilities: [ability(SHADOW_BLADES, 'cooldown', [])] }), new Set([SHADOW_BLADES]))).toBe(HEADER);
  });
});

describe('abilitiesByKind', () => {
  it('splits abilities into cooldowns and defensives, preserving order', () => {
    const cd1 = ability(SHADOW_BLADES, 'cooldown', [10]);
    const def = ability(EVASION, 'defensive', [20]);
    const cd2 = ability(SHADOW_DANCE, 'cooldown', [30]);
    expect(abilitiesByKind([cd1, def, cd2])).toEqual({ cooldowns: [cd1, cd2], defensives: [def] });
  });
});

describe('selectedIds', () => {
  it('includes every ability the user has not excluded (a new ability defaults on)', () => {
    const abilities = [ability(SHADOW_BLADES, 'cooldown', [10]), ability(SHADOW_DANCE, 'cooldown', [20])];
    expect(selectedIds(abilities, new Set([SHADOW_DANCE]))).toEqual(new Set([SHADOW_BLADES]));
  });
});

describe('isAllSelected', () => {
  const abilities = [ability(SHADOW_BLADES, 'cooldown', [10]), ability(SHADOW_DANCE, 'cooldown', [20])];
  it('is true when nothing is excluded', () => { expect(isAllSelected(abilities, new Set())).toBe(true); });
  it('is false when any ability is excluded', () => { expect(isAllSelected(abilities, new Set([SHADOW_DANCE]))).toBe(false); });
  it('is false for an empty list', () => { expect(isAllSelected([], new Set())).toBe(false); });
});

describe('toggleExclusion', () => {
  it('unchecking adds the id to the exclusion set', () => {
    expect(toggleExclusion(new Set(), SHADOW_BLADES, false)).toEqual(new Set([SHADOW_BLADES]));
  });

  it('checking removes the id from the exclusion set', () => {
    expect(toggleExclusion(new Set([SHADOW_BLADES]), SHADOW_BLADES, true)).toEqual(new Set());
  });

  it('does not mutate the input set', () => {
    const original = new Set([SHADOW_BLADES]);
    toggleExclusion(original, SHADOW_DANCE, false);
    expect(original).toEqual(new Set([SHADOW_BLADES]));
  });
});

describe('toggleAllExclusion', () => {
  const abilities = [ability(SHADOW_BLADES, 'cooldown', [10]), ability(SHADOW_DANCE, 'cooldown', [20])];

  it('excludes every ability when all are currently selected', () => {
    expect(toggleAllExclusion(abilities, new Set())).toEqual(new Set([SHADOW_BLADES, SHADOW_DANCE]));
  });

  it('clears all exclusions when some are currently deselected', () => {
    expect(toggleAllExclusion(abilities, new Set([SHADOW_BLADES]))).toEqual(new Set());
  });

  it('leaves persisted exclusions untouched over an empty ability list', () => {
    const excluded = new Set([SHADOW_BLADES, EVASION]);
    expect(toggleAllExclusion([], excluded)).toEqual(excluded);
  });
});

describe('isPanelOpen', () => {
  it('is open once requested while the bench has abilities to export', () => {
    expect(isPanelOpen(true, true)).toBe(true);
  });

  it('closes an already-open panel once the bench has nothing to export', () => {
    expect(isPanelOpen(true, false)).toBe(false);
  });

  it('stays closed when not requested even if the bench has abilities', () => {
    expect(isPanelOpen(false, true)).toBe(false);
  });
});

describe('NorthernSkyFeatureService', () => {
  it('returns the bench from its data source', async () => {
    const model = bench({ abilities: [{ spell_id: SHADOW_BLADES, name: 'Shadow Blades', icon: '', kind: 'cooldown', cast_times_s: [10] }] });
    TestBed.configureTestingModule({
      providers: [{ provide: NORTHERN_SKY_DATA_SOURCE, useValue: { getBench: async () => ok(model) } }],
    });
    const result = await TestBed.inject(NorthernSkyFeatureService).getExport('SubtletyRogue', ENCOUNTER_ID);
    expect(result).toEqual(ok(model));
  });

  it('propagates a missing bench so the export waiting state shows', async () => {
    TestBed.configureTestingModule({
      providers: [{ provide: NORTHERN_SKY_DATA_SOURCE, useValue: { getBench: async () => missing('Not yet ingested.') } }],
    });
    expect(await TestBed.inject(NorthernSkyFeatureService).getExport('SubtletyRogue', ENCOUNTER_ID)).toEqual(missing('Not yet ingested.'));
  });

  it('propagates a transient bench outage so the export surfaces a retry error', async () => {
    TestBed.configureTestingModule({
      providers: [{ provide: NORTHERN_SKY_DATA_SOURCE, useValue: { getBench: async () => transient('WCL is unreachable right now.') } }],
    });
    expect(await TestBed.inject(NorthernSkyFeatureService).getExport('SubtletyRogue', ENCOUNTER_ID)).toEqual(transient('WCL is unreachable right now.'));
  });
});
