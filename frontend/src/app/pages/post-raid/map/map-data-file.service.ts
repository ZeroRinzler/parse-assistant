import { Injectable, inject } from '@angular/core';
import { DataFileApiService } from '../../../core/services/data-file-api';
import { MapData, MapDataSource } from './map-data-source';

/**
 * Production `MapDataSource`: reads the ingested top-parse positions file via the
 * pass-through `DataFileApiService`. No transform - the file is already the
 * ready-to-draw bench (`EncounterPositions`); ingest writes it via `savePositions`.
 */
@Injectable({ providedIn: 'root' })
export class MapDataFileService implements MapDataSource {
  private readonly files = inject(DataFileApiService);

  getMapData(spec: string, encounterId: number): Promise<MapData | null> {
    return this.files.getPositions(spec, encounterId);
  }
}
