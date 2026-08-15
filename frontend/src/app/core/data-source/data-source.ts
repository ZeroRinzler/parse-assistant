// Implemented by FileDataSource (prod) and the slice's *TransformService (dev), swapped via each slice's *_DATA_SOURCE token.
import { Result } from '../result';

export interface DataSource<T> {
  /** `partition` is ingest-only: the transforms sample the one the orchestrator resolved, so every slice reads the parses the signature was taken over. */
  getBench(spec: string, encounterId: number, partition?: number | null): Promise<Result<T>>;
}
