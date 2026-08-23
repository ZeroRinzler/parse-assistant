// Implemented by FileDataSource (prod) and the slice's *TransformService (dev), swapped via each slice's *_DATA_SOURCE token.
import { Result } from '../http/result';
import { TopParseSelection } from '../wcl/wcl.models';

export interface DataSource<T> {
  /** `selection` is ingest-only: the orchestrator resolves it once per encounter, so every slice benches the parse set the signature was taken over. */
  getBench(spec: string, encounterId: number, selection?: TopParseSelection): Promise<Result<T>>;
}
