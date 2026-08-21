import { DataSource } from './data-source';
import { Result, missing } from '../result';

export class EmptyDataSource<T> implements DataSource<T> {
  getBench(): Promise<Result<T>> {
    return Promise.resolve(missing('Not yet ingested.'));
  }
}
