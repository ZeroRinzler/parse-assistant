import { Injectable, inject } from '@angular/core';
import { Rulebook } from '../models/rulebook.models';
import { EncounterEntry, SpecEntry } from '../models/encounter.models';
import { SpecMeta } from '../models/spec-meta.models';
import { EncounterPositions } from '../models/positioning.models';
import { DATA_FILE_TRANSPORT } from './data-file-transport';
import { Result, ok } from '../result';

// A manifest with no file yet is the legitimate empty fresh-tier state; a real read failure must propagate so the UI surfaces it instead of a silently empty list.
function foldMissingToEmpty<T>(result: Result<T[]>): Result<T[]> {
  if (result.ok) return result;
  return result.error.kind === 'missing' ? ok([]) : result;
}

// Delegates IO to an injected DataFileTransport so one API serves both runtimes: the browser binds an HTTP read-only transport, Node ingestion an fs read+write one.
@Injectable({ providedIn: 'root' })
export class DataFileApiService {
  private readonly io = inject(DATA_FILE_TRANSPORT);

  getSlice<T>(spec: string, encounterId: number, slice: string): Promise<Result<T>> {
    return this.io.readJson<T>(`${spec}/${slice}/${encounterId}.json`);
  }

  getRulebook(spec: string): Promise<Result<Rulebook>> {
    return this.io.readJson<Rulebook>(`${spec}/rulebook.json`);
  }

  async getSpecs(): Promise<Result<SpecEntry[]>> {
    return foldMissingToEmpty(await this.io.readJson<SpecEntry[]>('index.json'));
  }

  async getSpecMeta(): Promise<Result<SpecMeta[]>> {
    return foldMissingToEmpty(await this.io.readJson<SpecMeta[]>('spec-meta.json'));
  }

  async getEncounters(spec: string): Promise<Result<EncounterEntry[]>> {
    return foldMissingToEmpty(await this.io.readJson<EncounterEntry[]>(`${spec}/encounters.json`));
  }

  getPositions(spec: string, encounterId: number): Promise<Result<EncounterPositions>> {
    return this.io.readJson<EncounterPositions>(`${spec}/positions/${encounterId}.json`);
  }

  writeSlice(spec: string, encounterId: number, slice: string, data: unknown): Promise<void> {
    return this.io.writeJson(`${spec}/${slice}/${encounterId}.json`, data);
  }

  writePositions(spec: string, encounterId: number, data: EncounterPositions): Promise<void> {
    return this.io.writeJson(`${spec}/positions/${encounterId}.json`, data);
  }

  writeEncounters(spec: string, entries: EncounterEntry[]): Promise<void> {
    return this.io.writeJson(`${spec}/encounters.json`, entries);
  }

  writeSpecs(entries: SpecEntry[]): Promise<void> {
    return this.io.writeJson('index.json', entries);
  }

  writeSpecMeta(metas: SpecMeta[]): Promise<void> {
    return this.io.writeJson('spec-meta.json', metas);
  }

  // A spec folder name never contains a dot; otherwise the index rebuild reads `index.json/encounters.json` and hits ENOTDIR.
  async listSpecs(): Promise<string[]> {
    return (await this.io.list('')).filter(name => !name.includes('.'));
  }

  listSliceFiles(spec: string, slice: string): Promise<string[]> {
    return this.io.list(`${spec}/${slice}`);
  }

  removeSlice(spec: string, encounterId: number, slice: string): Promise<void> {
    return this.io.remove(`${spec}/${slice}/${encounterId}.json`);
  }
}
