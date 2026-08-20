import { describe, it, expect } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { DataFileApiService } from '../../core/services/data-file-api';
import { EncounterEntry, SpecEntry } from '../../core/models/encounter.models';
import { Result, ok, transient } from '../../core/result';
import { EncounterSelectionService } from './encounter-selection.service';

const SPEC = 'SubtletyRogue';

const TRANSIENT_ERROR = transient('WCL is unreachable right now.');

const BENCHED: EncounterEntry = { id: 3144, name: 'Boss A', sample_count: 12 };
const WAITING: EncounterEntry = { id: 3146, name: 'Boss C', sample_count: 0 };

/** Partial `DataFileApiService` fake: the service only calls `getSpecs` / `getEncounters`. */
function fakeFiles(
  specs: Result<SpecEntry[]>, encounters: Result<EncounterEntry[]>,
): { files: DataFileApiService; encounterCalls: string[] } {
  const encounterCalls: string[] = [];
  const files = {
    getSpecs: (): Promise<Result<SpecEntry[]>> => Promise.resolve(specs),
    getEncounters: (spec: string): Promise<Result<EncounterEntry[]>> => {
      encounterCalls.push(spec);
      return Promise.resolve(encounters);
    },
  } as DataFileApiService;
  return { files, encounterCalls };
}

function withFiles(specs: Result<SpecEntry[]>, encounters: Result<EncounterEntry[]>): {
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

  it('returns every listed encounter, including a zero-sample one still waiting for parses', async () => {
    const { service, encounterCalls } = withFiles(ok(SPECS), ok([BENCHED, WAITING]));
    expect(await service.getEncounters(SPEC)).toEqual(ok([BENCHED, WAITING]));
    expect(encounterCalls).toEqual([SPEC]);
  });

  it('propagates a read failure for a spec encounter index', async () => {
    const { service } = withFiles(ok(SPECS), TRANSIENT_ERROR);
    expect(await service.getEncounters(SPEC)).toEqual(TRANSIENT_ERROR);
  });
});
