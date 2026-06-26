import { Injectable, inject } from '@angular/core';
import { DataFileApiService } from '../../../core/services/data-file-api';
import { RotationBench, RotationDataSource } from './rotation-data-source';

/**
 * Production `RotationDataSource`: reads the ingested tailored rotation file via
 * the pass-through `DataFileApiService`. No transform - the file is already
 * prepared by the ingest `buildRotationSlice`.
 */
@Injectable({ providedIn: 'root' })
export class RotationDataFileService implements RotationDataSource {
  private readonly files = inject(DataFileApiService);

  getRotationBench(spec: string, encounterId: number): Promise<RotationBench | null> {
    return this.files.getSlice<RotationBench>(spec, encounterId, 'rotation');
  }
}
