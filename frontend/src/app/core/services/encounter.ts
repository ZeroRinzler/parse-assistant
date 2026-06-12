import { Injectable } from '@angular/core';
import { EncounterEntry, EncounterBench } from '../models/encounter.models';

const DATA_BASE = '/data/specs/';

@Injectable({ providedIn: 'root' })
export class EncounterService {

  async getEncounters(spec: string): Promise<EncounterEntry[]> {
    try {
      const resp = await fetch(`${DATA_BASE}${spec}/encounters.json`);
      if (resp.ok) {
        const data: EncounterEntry[] = await resp.json();
        return data.filter(e => e.sample_count > 0);
      }
    } catch { /* ignore */ }
    return [];
  }

  async getBench(spec: string, encounterId: number): Promise<EncounterBench | null> {
    try {
      const resp = await fetch(`${DATA_BASE}${spec}/encounters/${encounterId}.json`);
      if (resp.ok) return resp.json();
    } catch { /* ignore */ }
    return null;
  }

  async getRulebook(spec: string): Promise<{ major_cooldowns?: unknown[]; [key: string]: unknown } | null> {
    try {
      const resp = await fetch(`${DATA_BASE}${spec}/rulebook.json`);
      if (resp.ok) return resp.json();
    } catch { /* ignore */ }
    return null;
  }
}
