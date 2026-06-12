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
    } catch { /* fall through */ }

    try {
      const resp = await fetch(`/api/admin/parses/stats/${spec}`);
      if (resp.ok) {
        const data: { stats: Record<string, { sample_count: number; encounter_name: string; last_ingested?: string }> } = await resp.json();
        return Object.entries(data.stats || {})
          .map(([enc_id, s]) => ({ id: parseInt(enc_id, 10), name: s.encounter_name, sample_count: s.sample_count, last_ingested: s.last_ingested }))
          .filter(e => e.sample_count > 0);
      }
    } catch { /* ignore */ }

    return [];
  }

  async getBench(spec: string, encounterId: number): Promise<EncounterBench | null> {
    try {
      const resp = await fetch(`${DATA_BASE}${spec}/encounters/${encounterId}.json`);
      if (resp.ok) return resp.json();
    } catch { /* fall through */ }

    try {
      const resp = await fetch(`/api/pre/gear-stats/${spec}/${encounterId}`);
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
