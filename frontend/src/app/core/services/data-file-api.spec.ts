import { describe, it, expect } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { DataFileApiService } from './data-file-api';
import { DATA_FILE_TRANSPORT, DataFileTransport } from './data-file-transport';
import { EncounterEntry, SpecEntry } from '../models/encounter.models';

/**
 * DataFileApiService is a pass-through over the ingested static files: it owns the
 * relative-path contract that the browser reads and the Node ingestion writes
 * (`{spec}/{slice}/{enc}.json`, `{spec}/rulebook.json`, `index.json`, ...). These
 * tests pin those exact paths - a drift here silently 404s every runtime read or
 * writes ingested data to the wrong place - and the `listSpecs` dot-filter that keeps
 * the index rebuild from treating `index.json` as a spec folder.
 */
const SPEC = 'SubtletyRogue';
const ENCOUNTER_ID = 3176;
const SLICE = 'burst';

/** Records every transport call so a test can assert the exact relative path used. */
class RecordingTransport implements DataFileTransport {
  readonly reads: string[] = [];
  readonly writes: [string, unknown][] = [];
  readonly removes: string[] = [];
  readonly lists: string[] = [];

  constructor(
    private readonly readValue: unknown = null,
    private readonly listValue: string[] = [],
  ) {}

  readJson<T>(relPath: string): Promise<T | null> {
    this.reads.push(relPath);
    return Promise.resolve(this.readValue as T | null);
  }

  writeJson(relPath: string, data: unknown): Promise<void> {
    this.writes.push([relPath, data]);
    return Promise.resolve();
  }

  remove(relPath: string): Promise<void> {
    this.removes.push(relPath);
    return Promise.resolve();
  }

  list(relDir: string): Promise<string[]> {
    this.lists.push(relDir);
    return Promise.resolve(this.listValue);
  }
}

function withTransport(transport: DataFileTransport): DataFileApiService {
  // Reset so a test can build the service twice (e.g. present vs missing file) in one case.
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      DataFileApiService,
      { provide: DATA_FILE_TRANSPORT, useValue: transport },
    ],
  });
  return TestBed.inject(DataFileApiService);
}

describe('DataFileApiService reads', () => {
  it('reads a tailored slice file at {spec}/{slice}/{enc}.json', async () => {
    const bench = { encounter_id: ENCOUNTER_ID };
    const transport = new RecordingTransport(bench);

    const result = await withTransport(transport).getSlice(SPEC, ENCOUNTER_ID, SLICE);

    expect(result).toBe(bench);
    expect(transport.reads).toEqual(['SubtletyRogue/burst/3176.json']);
  });

  it('reads a rulebook at {spec}/rulebook.json', async () => {
    const transport = new RecordingTransport({ spec: SPEC });
    await withTransport(transport).getRulebook(SPEC);
    expect(transport.reads).toEqual(['SubtletyRogue/rulebook.json']);
  });

  it('reads positions at {spec}/positions/{enc}.json', async () => {
    const transport = new RecordingTransport(null);
    await withTransport(transport).getPositions(SPEC, ENCOUNTER_ID);
    expect(transport.reads).toEqual(['SubtletyRogue/positions/3176.json']);
  });

  it('reads the spec manifest at index.json, defaulting a missing file to []', async () => {
    const specs: SpecEntry[] = [{ spec: SPEC, encounter_count: 2 }];
    const present = new RecordingTransport(specs);
    expect(await withTransport(present).getSpecs()).toBe(specs);
    expect(present.reads).toEqual(['index.json']);

    const missing = new RecordingTransport(null);
    expect(await withTransport(missing).getSpecs()).toEqual([]);
  });

  it('reads a spec encounter index at {spec}/encounters.json, defaulting a missing file to []', async () => {
    const encounters: EncounterEntry[] = [{ id: ENCOUNTER_ID, name: 'Boss', sample_count: 5 }];
    const present = new RecordingTransport(encounters);
    expect(await withTransport(present).getEncounters(SPEC)).toBe(encounters);
    expect(present.reads).toEqual(['SubtletyRogue/encounters.json']);

    const missing = new RecordingTransport(null);
    expect(await withTransport(missing).getEncounters(SPEC)).toEqual([]);
  });
});

describe('DataFileApiService writes and listing', () => {
  it('writes a tailored slice to {spec}/{slice}/{enc}.json', async () => {
    const transport = new RecordingTransport();
    const data = { computed: true };
    await withTransport(transport).writeSlice(SPEC, ENCOUNTER_ID, SLICE, data);
    expect(transport.writes).toEqual([['SubtletyRogue/burst/3176.json', data]]);
  });

  it('writes the spec manifest to index.json', async () => {
    const transport = new RecordingTransport();
    const specs: SpecEntry[] = [{ spec: SPEC, encounter_count: 1 }];
    await withTransport(transport).writeSpecs(specs);
    expect(transport.writes).toEqual([['index.json', specs]]);
  });

  it('removes a tailored slice at {spec}/{slice}/{enc}.json', async () => {
    const transport = new RecordingTransport();
    await withTransport(transport).removeSlice(SPEC, ENCOUNTER_ID, SLICE);
    expect(transport.removes).toEqual(['SubtletyRogue/burst/3176.json']);
  });

  it('lists slice files under {spec}/{slice}', async () => {
    const transport = new RecordingTransport(null, ['3176.json', '3177.json']);
    const files = await withTransport(transport).listSliceFiles(SPEC, SLICE);
    expect(files).toEqual(['3176.json', '3177.json']);
    expect(transport.lists).toEqual(['SubtletyRogue/burst']);
  });

  it('lists spec folders from the root, dropping any name with a dot so index.json is not a spec', async () => {
    // The specs root also holds index.json (and possibly dotfiles); a spec folder name
    // never contains a dot, so those are filtered - otherwise the index rebuild would
    // read index.json/encounters.json and hit ENOTDIR.
    const transport = new RecordingTransport(null, ['SubtletyRogue', 'FireMage', 'index.json', '.gitkeep']);
    const specs = await withTransport(transport).listSpecs();
    expect(specs).toEqual(['SubtletyRogue', 'FireMage']);
    expect(transport.lists).toEqual(['']);
  });
});
