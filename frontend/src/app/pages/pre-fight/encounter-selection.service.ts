/** Pre-fight spec + encounter discovery shell over the data-file indices. */
import { Injectable, inject } from '@angular/core';
import { DataFileApiService } from '../../core/services/data-file-api';
import { EncounterEntry, SpecEntry } from '../../core/models/encounter.models';
import { Result } from '../../core/result';

@Injectable({ providedIn: 'root' })
export class EncounterSelectionService {
  private readonly files = inject(DataFileApiService);

  getSpecs(): Promise<Result<SpecEntry[]>> {
    return this.files.getSpecs();
  }

  /** Zero-sample entries stay listed: selecting one is what shows the waiting banner while a new raid has no parses yet. */
  getEncounters(spec: string): Promise<Result<EncounterEntry[]>> {
    return this.files.getEncounters(spec);
  }
}
