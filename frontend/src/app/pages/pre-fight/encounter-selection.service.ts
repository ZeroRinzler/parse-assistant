/**
 * Pre-fight spec + encounter discovery shell + its pure projection, colocated.
 *
 * `EncounterSelectionService` is the imperative shell the pre-fight page injects
 * for reading the ingested manifest and encounter indexes. It wraps the
 * pass-through `DataFileApiService` so the page shell stays free of the transport
 * and of the one projection the discovery needs (dropping bench-less encounters).
 *
 * The projection is the named, pure `benchedEncounters` below; the service itself
 * contains no arithmetic - it only reads a file and applies that pure filter.
 */
import { Injectable, inject } from '@angular/core';
import { DataFileApiService } from '../../core/services/data-file-api';
import { EncounterEntry, SpecEntry } from '../../core/models/encounter.models';

/* ----------------------------- pure projection ---------------------------- */

/**
 * The encounters a spec actually has bench data for: those with at least one
 * ingested sample. Order-preserving, so the dropdown keeps the ingested order.
 */
export function benchedEncounters(entries: EncounterEntry[]): EncounterEntry[] {
  return entries.filter(entry => entry.sample_count > 0);
}

/* ----------------------------- discovery shell ---------------------------- */

@Injectable({ providedIn: 'root' })
export class EncounterSelectionService {
  private readonly files = inject(DataFileApiService);

  /** The ingested spec manifest, for the class / spec dropdowns. */
  getSpecs(): Promise<SpecEntry[]> {
    return this.files.getSpecs();
  }

  /** A spec's encounters that carry bench samples (empty ones dropped). */
  async getEncounters(spec: string): Promise<EncounterEntry[]> {
    return benchedEncounters(await this.files.getEncounters(spec));
  }
}
