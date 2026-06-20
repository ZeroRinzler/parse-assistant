import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { EncounterEntry, EncounterBench, SpecEntry } from '../models/encounter.models';
import { EncounterPositions } from '../models/positioning.models';
import { Rulebook } from '../models/rulebook.models';

const DATA_BASE = new URL('data/specs/', document.baseURI).href;

@Injectable({ providedIn: 'root' })
export class EncounterService {
  private readonly http = inject(HttpClient);

  async getSpecs(): Promise<SpecEntry[]> {
    try {
      const data = await firstValueFrom(this.http.get<SpecEntry[]>(`${DATA_BASE}index.json`));
      return data || [];
    } catch { /* not yet generated */ }
    return [];
  }

  async getEncounters(spec: string): Promise<EncounterEntry[]> {
    try {
      const data = await firstValueFrom(this.http.get<EncounterEntry[]>(`${DATA_BASE}${spec}/encounters.json`));
      return (data || []).filter(e => e.sample_count > 0);
    } catch { /* ignore */ }
    return [];
  }

  async getBench(spec: string, encounterId: number): Promise<EncounterBench | null> {
    try {
      return await firstValueFrom(this.http.get<EncounterBench>(`${DATA_BASE}${spec}/encounters/${encounterId}.json`));
    } catch { /* ignore */ }
    return null;
  }

  /** Ingested top-parse position timelines for the map. Null until re-ingested. */
  async getPositions(spec: string, encounterId: number): Promise<EncounterPositions | null> {
    try {
      return await firstValueFrom(this.http.get<EncounterPositions>(`${DATA_BASE}${spec}/positions/${encounterId}.json`));
    } catch { /* not ingested yet */ }
    return null;
  }

  async getRulebook(spec: string): Promise<Rulebook | null> {
    try {
      return await firstValueFrom(this.http.get<Rulebook>(`${DATA_BASE}${spec}/rulebook.json`));
    } catch { /* ignore */ }
    return null;
  }
}
