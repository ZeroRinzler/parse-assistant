import { DataFileApiService } from '../services/data-file-api';
import { DataSource } from './data-source';

/**
 * Production `DataSource<T>` for every slice: reads the ingest-baked tailored file
 * `data/specs/{spec}/{slice}/{enc}.json` through the pass-through `DataFileApiService`.
 *
 * One generic class replaces the five per-slice `*DataFileService` forwarders - the only
 * thing that ever varied across them was the slice directory name, now a constructor
 * argument. It is NOT `providedIn: 'root'`: `provideDataSource` instantiates one per token
 * (via `useFactory`) so each `*_DATA_SOURCE` binds its own slice. The map slice reads its
 * positions file via the same path shape with `slice = 'positions'`.
 */
export class FileDataSource<T> implements DataSource<T> {
  constructor(private readonly files: DataFileApiService, private readonly slice: string) {}

  getBench(spec: string, encounterId: number): Promise<T | null> {
    return this.files.getSlice<T>(spec, encounterId, this.slice);
  }
}
