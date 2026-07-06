// The seam every slice's data source satisfies. Two adapters cross it: FileDataSource<T>
// (production, reads the baked file) and the slice's own *TransformService (dev flag /
// ingestion, computes it live). T is narrowed per slice by its *_DATA_SOURCE token.
import { Result, LoadError } from '../result';

export interface DataSource<T> {
  getBench(spec: string, encounterId: number): Promise<Result<T, LoadError>>;
}
