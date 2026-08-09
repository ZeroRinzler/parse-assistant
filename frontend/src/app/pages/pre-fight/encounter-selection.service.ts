/** Pre-fight spec + encounter discovery shell, colocated with its one pure projection so the page shell stays free of the transport. */
import { Injectable, inject } from '@angular/core';
import { DataFileApiService } from '../../core/services/data-file-api';
import { EncounterEntry, SpecEntry } from '../../core/models/encounter.models';
import { Result, LoadError, ok } from '../../core/result';

/** Order-preserving, so the dropdown keeps the ingested order. */
export function benchedEncounters(entries: EncounterEntry[]): EncounterEntry[] {
  return entries.filter(entry => entry.sample_count > 0);
}

@Injectable({ providedIn: 'root' })
export class EncounterSelectionService {
  private readonly files = inject(DataFileApiService);

  getSpecs(): Promise<Result<SpecEntry[], LoadError>> {
    return this.files.getSpecs();
  }

  async getEncounters(spec: string): Promise<Result<EncounterEntry[], LoadError>> {
    const result = await this.files.getEncounters(spec);
    return result.ok ? ok(benchedEncounters(result.value)) : result;
  }
}
