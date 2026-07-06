import { describe, it, expect } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { DataFileApiService } from '../../core/services/data-file-api';
import { EncounterEntry, SpecEntry } from '../../core/models/encounter.models';
import { Result, LoadError, ok, transient } from '../../core/result';
import { EncounterSelectionService, benchedEncounters } from './encounter-selection.service';

const SPEC = 'SubtletyRogue';

const TRANSIENT_ERROR = transient('WCL is unreachable right now.');

// sample_count spans the boundary: 12 and 1 are benched, 0 is empty.
const BENCHED: EncounterEntry = { id: 3144, name: 'Boss A', sample_count: 12 };
const ALSO_BENCHED: EncounterEntry = { id: 3145, name: 'Boss B', sample_count: 1 };
const EMPTY: EncounterEntry = { id: 3146, name: 'Boss C', sample_count: 0 };

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

/** Partial `DataFileApiService` fake: the service only calls `getSpecs` / `getEncounters`. */
function fakeFiles(
  specs: Result<SpecEntry[], LoadError>, encounters: Result<EncounterEntry[], LoadError>,
): { files: DataFileApiService; encounterCalls: string[] } {
  const encounterCalls: string[] = [];
  const files = {
    getSpecs: (): Promise<Result<SpecEntry[], LoadError>> => Promise.resolve(specs),
    getEncounters: (spec: string): Promise<Result<EncounterEntry[], LoadError>> => {
      encounterCalls.push(spec);
      return Promise.resolve(encounters);
    },
  } as DataFileApiService;
  return { files, encounterCalls };
}

function withFiles(specs: Result<SpecEntry[], LoadError>, encounters: Result<EncounterEntry[], LoadError>): {
  service: EncounterSelectionService; encounterCalls: string[];
} {
  const { files, encounterCalls } = fakeFiles(specs, encounters);
  TestBed.configureTestingModule({ providers: [{ provide: DataFileApiService, useValue: files }] });
  return { service: TestBed.inject(EncounterSelectionService), encounterCalls };
}

describe('EncounterSelectionService', () => {
  const SPECS: SpecEntry[] = [{ spec: SPEC, encounter_count: 2 }];

  it('reads the spec manifest through DataFileApiService', async () => {
    const { service } = withFiles(ok(SPECS), ok([]));
    expect(await service.getSpecs()).toEqual(ok(SPECS));
  });

  it('propagates a read failure for the spec manifest', async () => {
    const { service } = withFiles(TRANSIENT_ERROR, ok([]));
    expect(await service.getSpecs()).toEqual(TRANSIENT_ERROR);
  });

  it('returns only the benched encounters for a spec', async () => {
    const { service, encounterCalls } = withFiles(ok(SPECS), ok([BENCHED, EMPTY, ALSO_BENCHED]));
    expect(await service.getEncounters(SPEC)).toEqual(ok([BENCHED, ALSO_BENCHED]));
    expect(encounterCalls).toEqual([SPEC]);
  });

  it('propagates a read failure for a spec encounter index', async () => {
    const { service } = withFiles(ok(SPECS), TRANSIENT_ERROR);
    expect(await service.getEncounters(SPEC)).toEqual(TRANSIENT_ERROR);
  });
});
