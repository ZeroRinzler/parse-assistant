import { Injectable, inject } from '@angular/core';
import { DataFileApiService } from '../../../core/services/data-file-api';
import { BurstBench, BurstDataSource } from './burst-data-source';

/**
 * Production `BurstDataSource`: reads the ingested tailored burst file via the
 * pass-through `DataFileApiService`. No transform - the file is already prepared.
 */
@Injectable({ providedIn: 'root' })
export class BurstDataFileService implements BurstDataSource {
  private readonly files = inject(DataFileApiService);

  getBurstBench(spec: string, encounterId: number): Promise<BurstBench | null> {
    return this.files.getSlice<BurstBench>(spec, encounterId, 'burst');
  }
}
