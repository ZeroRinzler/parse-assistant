import { DataFileApiService } from '../services/data-file-api';
import { DataSource } from './data-source';
import { Result, LoadError } from '../result';

// Production DataSource for every slice, reading `data/specs/{spec}/{slice}/{enc}.json`
// through DataFileApiService. One generic class covers all slices - the slice directory is
// the only thing that varied, now a constructor argument (the map binds slice='positions').
// provideDataSource instantiates one per *_DATA_SOURCE token, so it is not providedIn root.
export class FileDataSource<T> implements DataSource<T> {
  constructor(private readonly files: DataFileApiService, private readonly slice: string) {}

  getBench(spec: string, encounterId: number): Promise<Result<T, LoadError>> {
    return this.files.getSlice<T>(spec, encounterId, this.slice);
  }
}
