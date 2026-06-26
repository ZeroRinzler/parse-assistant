import { Injectable, inject } from '@angular/core';
import { DataFileApiService } from '../../../core/services/data-file-api';
import { DefensiveBench, DefensiveDataSource } from './defensive-data-source';

/**
 * Production `DefensiveDataSource`: reads the ingested tailored defensive file via the
 * pass-through `DataFileApiService`. No transform - the file is already prepared.
 */
@Injectable({ providedIn: 'root' })
export class DefensiveDataFileService implements DefensiveDataSource {
  private readonly files = inject(DataFileApiService);

  getDefensiveBench(spec: string, encounterId: number): Promise<DefensiveBench | null> {
    return this.files.getSlice<DefensiveBench>(spec, encounterId, 'defensive');
  }
}
