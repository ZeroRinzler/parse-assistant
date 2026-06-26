import { Injectable, inject } from '@angular/core';
import { DataFileApiService } from '../../../core/services/data-file-api';
import { GearBench, GearDataSource } from './gear-data-source';

/**
 * Production `GearDataSource`: reads the ingested tailored gear file via the
 * pass-through `DataFileApiService`. No transform - the file is already prepared.
 */
@Injectable({ providedIn: 'root' })
export class GearDataFileService implements GearDataSource {
  private readonly files = inject(DataFileApiService);

  getGearBench(spec: string, encounterId: number): Promise<GearBench | null> {
    return this.files.getSlice<GearBench>(spec, encounterId, 'gear');
  }
}
