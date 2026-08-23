import { DataFileApiService } from '../data-files/data-file-api-service';
import { DataSource } from './data-source';
import { Result } from '../http/result';

// provideDataSource instantiates one per *_DATA_SOURCE token, so it is not providedIn root.
export class FileDataSource<T> implements DataSource<T> {
  constructor(private readonly files: DataFileApiService, private readonly slice: string) {}

  getBench(spec: string, encounterId: number): Promise<Result<T>> {
    return this.files.getSlice<T>(spec, encounterId, this.slice);
  }
}
