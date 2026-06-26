import { Injectable, inject } from '@angular/core';
import { Rulebook } from '../models/rulebook.models';
import { EncounterEntry, SpecEntry } from '../models/encounter.models';
import { EncounterPositions } from '../models/positioning.models';
import { DATA_FILE_TRANSPORT } from './data-file-transport';

/**
 * Data API over the ingested static files. Reads are pass-through (no transform):
 * it returns the `data/specs/**` JSON as-is, and per-use-case slices read their own
 * tailored file via `getSlice` (the production half of a `*DataSource`).
 *
 * It delegates IO to an injected {@link DataFileTransport}: the browser binds an
 * HTTP read-only transport; the Node ingestion binds a filesystem read+write one and
 * uses the `write*`/`list*`/`remove*` helpers to persist the transforms' output -
 * so the same data API serves both the runtime and ingestion.
 */
@Injectable({ providedIn: 'root' })
export class DataFileApiService {
  private readonly io = inject(DATA_FILE_TRANSPORT);

  // ── Reads (browser + Node) ──────────────────────────────────────────────────

  /** Raw read of a per-use-case tailored slice file (`{spec}/{slice}/{enc}.json`). */
  getSlice<T>(spec: string, encounterId: number, slice: string): Promise<T | null> {
    return this.io.readJson<T>(`${spec}/${slice}/${encounterId}.json`);
  }

  /** Raw read of a spec's rulebook (`{spec}/rulebook.json`). */
  getRulebook(spec: string): Promise<Rulebook | null> {
    return this.io.readJson<Rulebook>(`${spec}/rulebook.json`);
  }

  /** Raw read of the spec manifest (`index.json`). Empty when not yet generated. */
  async getSpecs(): Promise<SpecEntry[]> {
    return (await this.io.readJson<SpecEntry[]>('index.json')) ?? [];
  }

  /** Raw read of a spec's encounter index (`{spec}/encounters.json`). */
  async getEncounters(spec: string): Promise<EncounterEntry[]> {
    return (await this.io.readJson<EncounterEntry[]>(`${spec}/encounters.json`)) ?? [];
  }

  /** Raw read of ingested top-parse position timelines (`{spec}/positions/{enc}.json`). */
  getPositions(spec: string, encounterId: number): Promise<EncounterPositions | null> {
    return this.io.readJson<EncounterPositions>(`${spec}/positions/${encounterId}.json`);
  }

  // ── Writes / listing (Node ingestion only) ──────────────────────────────────

  /** Write a per-use-case tailored slice file. */
  writeSlice(spec: string, encounterId: number, slice: string, data: unknown): Promise<void> {
    return this.io.writeJson(`${spec}/${slice}/${encounterId}.json`, data);
  }

  /** Write the top-parse position timelines for an encounter. */
  writePositions(spec: string, encounterId: number, data: EncounterPositions): Promise<void> {
    return this.io.writeJson(`${spec}/positions/${encounterId}.json`, data);
  }

  /** Write a spec's encounter index. */
  writeEncounters(spec: string, entries: EncounterEntry[]): Promise<void> {
    return this.io.writeJson(`${spec}/encounters.json`, entries);
  }

  /** Write the top-level spec manifest. */
  writeSpecs(entries: SpecEntry[]): Promise<void> {
    return this.io.writeJson('index.json', entries);
  }

  /**
   * List spec folder names (Node only). The specs root also holds the `index.json`
   * manifest (and possibly stray dotfiles); a spec folder is a WCL spec name and never
   * contains a dot, so filter those out - otherwise the index rebuild would treat
   * `index.json` as a spec and read `index.json/encounters.json` (ENOTDIR).
   */
  async listSpecs(): Promise<string[]> {
    return (await this.io.list('')).filter(name => !name.includes('.'));
  }

  /** List the JSON file names under `{spec}/{slice}/` (Node only). */
  listSliceFiles(spec: string, slice: string): Promise<string[]> {
    return this.io.list(`${spec}/${slice}`);
  }

  /** Remove a tailored slice / positions file (pruning; Node only). */
  removeSlice(spec: string, encounterId: number, slice: string): Promise<void> {
    return this.io.remove(`${spec}/${slice}/${encounterId}.json`);
  }
}
