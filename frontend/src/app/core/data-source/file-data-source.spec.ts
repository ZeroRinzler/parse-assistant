import { describe, it, expect } from 'vitest';
import { DataFileApiService } from '../services/data-file-api';
import { FileDataSource } from './file-data-source';
import { Result, ok, missing } from '../result';

interface DummyBench { encounter_id: number; }

const SPEC = 'SubtletyRogue';
const ENCOUNTER_ID = 3144;
const SLICE = 'rotation';

/** A partial `DataFileApiService` fake - `FileDataSource` only ever calls `getSlice`. */
function fakeFiles(
  result: Result<DummyBench>,
): { files: DataFileApiService; calls: [string, number, string][] } {
  const calls: [string, number, string][] = [];
  const files = {
    getSlice: <T>(spec: string, encounterId: number, slice: string): Promise<Result<T>> => {
      calls.push([spec, encounterId, slice]);
      return Promise.resolve(result as Result<T>);
    },
  } as DataFileApiService;
  return { files, calls };
}

describe('FileDataSource', () => {
  it('reads its slice file by name through DataFileApiService.getSlice', async () => {
    const bench: DummyBench = { encounter_id: ENCOUNTER_ID };
    const { files, calls } = fakeFiles(ok(bench));

    const result = await new FileDataSource<DummyBench>(files, SLICE).getBench(SPEC, ENCOUNTER_ID);

    expect(result).toEqual(ok(bench));
    expect(calls).toEqual([[SPEC, ENCOUNTER_ID, SLICE]]);
  });

  it('passes an un-ingested slice file through as missing', async () => {
    const { files } = fakeFiles(missing('Not yet ingested.'));
    expect(await new FileDataSource<DummyBench>(files, SLICE).getBench(SPEC, ENCOUNTER_ID))
      .toEqual(missing('Not yet ingested.'));
  });

  it('reads the slice directory it was constructed with (map binds "positions")', async () => {
    const { files, calls } = fakeFiles(missing('Not yet ingested.'));
    await new FileDataSource<DummyBench>(files, 'positions').getBench(SPEC, ENCOUNTER_ID);
    expect(calls[0][2]).toBe('positions');
  });
});
