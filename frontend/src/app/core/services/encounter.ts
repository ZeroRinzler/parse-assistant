import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { EncounterEntry, EncounterBench } from '../models/encounter.models';
import { Rulebook } from '../models/rulebook.models';

const DATA_BASE = new URL('data/specs/', document.baseURI).href;

@Injectable({ providedIn: 'root' })
export class EncounterService {
  private readonly http = inject(HttpClient);

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

  async getRulebook(spec: string): Promise<Rulebook | null> {
    try {
      return await firstValueFrom(this.http.get<{ major_cooldowns?: unknown[]; [key: string]: unknown }>(`${DATA_BASE}${spec}/rulebook.json`));
    } catch { /* ignore */ }
    return null;
  }
}
