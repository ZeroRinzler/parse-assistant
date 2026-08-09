import { DataSource } from './data-source';
import { Result, LoadError, missing } from '../result';

// Bound by the `empty` environment; taking no dependencies keeps the transforms tree-shaken out.
export class EmptyDataSource<T> implements DataSource<T> {
  getBench(): Promise<Result<T, LoadError>> {
    return Promise.resolve(missing('Not yet ingested.'));
  }
}
