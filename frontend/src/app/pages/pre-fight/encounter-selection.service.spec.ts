import { describe, it, expect } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { DataFileApiService } from '../../core/services/data-file-api';
import { EncounterEntry, SpecEntry } from '../../core/models/encounter.models';
import { EncounterSelectionService, benchedEncounters } from './encounter-selection.service';

const SPEC = 'SubtletyRogue';

/** A benched encounter carries at least one ingested sample; an empty one carries zero. */
const BENCHED: EncounterEntry = { id: 3144, name: 'Boss A', sample_count: 12 };
const ALSO_BENCHED: EncounterEntry = { id: 3145, name: 'Boss B', sample_count: 1 };
const EMPTY: EncounterEntry = { id: 3146, name: 'Boss C', sample_count: 0 };

/* ----------------------------- pure projection ---------------------------- */

describe('benchedEncounters', () => {
  it('keeps encounters with at least one sample', () => {
    expect(benchedEncounters([BENCHED, ALSO_BENCHED])).toEqual([BENCHED, ALSO_BENCHED]);
  });

  it('drops encounters with zero samples (boundary: sample_count 0 is out, 1 is in)', () => {
    expect(benchedEncounters([BENCHED, EMPTY, ALSO_BENCHED])).toEqual([BENCHED, ALSO_BENCHED]);
  });

  it('preserves the ingested order', () => {
    expect(benchedEncounters([ALSO_BENCHED, BENCHED]).map(entry => entry.id)).toEqual([ALSO_BENCHED.id, BENCHED.id]);
  });
});

/* ----------------------------- discovery shell ---------------------------- */

/** A partial `DataFileApiService` fake - the service only calls `getSpecs` / `getEncounters`. */
function fakeFiles(
  specs: SpecEntry[], encounters: EncounterEntry[],
): { files: DataFileApiService; encounterCalls: string[] } {
  const encounterCalls: string[] = [];
  const files = {
    getSpecs: (): Promise<SpecEntry[]> => Promise.resolve(specs),
    getEncounters: (spec: string): Promise<EncounterEntry[]> => {
      encounterCalls.push(spec);
      return Promise.resolve(encounters);
    },
  } as DataFileApiService;
  return { files, encounterCalls };
}

function withFiles(specs: SpecEntry[], encounters: EncounterEntry[]): {
  service: EncounterSelectionService; encounterCalls: string[];
} {
  const { files, encounterCalls } = fakeFiles(specs, encounters);
  TestBed.configureTestingModule({ providers: [{ provide: DataFileApiService, useValue: files }] });
  return { service: TestBed.inject(EncounterSelectionService), encounterCalls };
}

describe('EncounterSelectionService', () => {
  const SPECS: SpecEntry[] = [{ spec: SPEC, encounter_count: 2 }];

  it('reads the spec manifest through DataFileApiService', async () => {
    const { service } = withFiles(SPECS, []);
    expect(await service.getSpecs()).toEqual(SPECS);
  });

  it('returns only the benched encounters for a spec', async () => {
    const { service, encounterCalls } = withFiles(SPECS, [BENCHED, EMPTY, ALSO_BENCHED]);
    expect(await service.getEncounters(SPEC)).toEqual([BENCHED, ALSO_BENCHED]);
    expect(encounterCalls).toEqual([SPEC]);
  });
});
