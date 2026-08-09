// Implemented by FileDataSource (prod) and the slice's *TransformService (dev), swapped via each slice's *_DATA_SOURCE token.
import { Result, LoadError } from '../result';

export interface DataSource<T> {
  getBench(spec: string, encounterId: number): Promise<Result<T, LoadError>>;
}
