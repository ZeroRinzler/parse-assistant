import { describe, it, expect } from 'vitest';
import { DataFileApiService } from '../services/data-file-api';
import { FileDataSource } from './file-data-source';

interface DummyBench { encounter_id: number; }

const SPEC = 'SubtletyRogue';
const ENCOUNTER_ID = 3144;
const SLICE = 'rotation';

/** A partial `DataFileApiService` fake - `FileDataSource` only ever calls `getSlice`. */
function fakeFiles(value: DummyBench | null): { files: DataFileApiService; calls: [string, number, string][] } {
  const calls: [string, number, string][] = [];
  const files = {
    getSlice: <T>(spec: string, encounterId: number, slice: string): Promise<T | null> => {
      calls.push([spec, encounterId, slice]);
      return Promise.resolve(value as T | null);
    },
  } as DataFileApiService;
  return { files, calls };
}

describe('FileDataSource', () => {
  it('reads its slice file by name through DataFileApiService.getSlice', async () => {
    const bench: DummyBench = { encounter_id: ENCOUNTER_ID };
    const { files, calls } = fakeFiles(bench);

    const result = await new FileDataSource<DummyBench>(files, SLICE).getBench(SPEC, ENCOUNTER_ID);

    expect(result).toBe(bench);
    expect(calls).toEqual([[SPEC, ENCOUNTER_ID, SLICE]]);
  });

  it('passes a missing file through as null', async () => {
    const { files } = fakeFiles(null);
    expect(await new FileDataSource<DummyBench>(files, SLICE).getBench(SPEC, ENCOUNTER_ID)).toBeNull();
  });

  it('reads the slice directory it was constructed with (map binds "positions")', async () => {
    const { files, calls } = fakeFiles(null);
    await new FileDataSource<DummyBench>(files, 'positions').getBench(SPEC, ENCOUNTER_ID);
    expect(calls[0][2]).toBe('positions');
  });
});
