import { DataSource } from './data-source';

/**
 * A `DataSource<T>` whose `getBench` always resolves `null` - a fresh, un-ingested tier.
 * Bound by the `empty` environment; takes no dependencies, so it keeps the transforms
 * tree-shaken out like `FileDataSource`.
 */
export class EmptyDataSource<T> implements DataSource<T> {
  getBench(): Promise<T | null> {
    return Promise.resolve(null);
  }
}
