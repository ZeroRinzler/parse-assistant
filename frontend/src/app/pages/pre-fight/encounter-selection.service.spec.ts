import { describe, it, expect } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { DataFileApiService } from '../../core/services/data-file-api';
import { EncounterEntry } from '../../core/models/encounter.models';
import { Result, ok } from '../../core/result';
import { EncounterSelectionService } from './encounter-selection.service';

const SPEC = 'SubtletyRogue';

const BENCHED: EncounterEntry = { id: 3144, name: 'Boss A', sample_count: 12 };
const WAITING: EncounterEntry = { id: 3146, name: 'Boss C', sample_count: 0 };

function serviceWith(encounters: Result<EncounterEntry[]>): EncounterSelectionService {
  const files = {
    getEncounters: (): Promise<Result<EncounterEntry[]>> => Promise.resolve(encounters),
  } as unknown as DataFileApiService;
  TestBed.configureTestingModule({ providers: [{ provide: DataFileApiService, useValue: files }] });
  return TestBed.inject(EncounterSelectionService);
}

describe('EncounterSelectionService', () => {
  it('returns every listed encounter, including a zero-sample one still waiting for parses', async () => {
    expect(await serviceWith(ok([BENCHED, WAITING])).getEncounters(SPEC)).toEqual(ok([BENCHED, WAITING]));
  });
});
