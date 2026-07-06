import { HttpErrorResponse } from '@angular/common/http';
import { Result, LoadError, missing, transient, permanent } from './result';
import { WclTransportError } from './services/wcl-transport';

// The interceptor already retried these once, so reaching here means the retry did not
// help. Status 0 is a network/CORS drop or the status-0 WclTransportError a GraphQL-level
// failure raises.
const TRANSIENT_STATUSES = new Set([0, 408, 429, 500, 502, 503, 504]);
const HTTP_NOT_FOUND = 404;

/**
 * The single place an HTTP/transport status becomes a taxonomy variant, so slices never
 * re-derive the mapping. Only for the catch site: a pure-core semantic failure calls the
 * `missing`/`permanent` builders directly.
 */
export function toLoadError(cause: unknown, id: string): Result<never, LoadError> {
  const status =
    cause instanceof HttpErrorResponse ? cause.status
    : cause instanceof WclTransportError ? cause.status
    : -1;

  if (status === HTTP_NOT_FOUND) return missing('Not yet ingested.');
  if (TRANSIENT_STATUSES.has(status)) return transient('WCL is unreachable right now.');
  return permanent('Analysis data could not be loaded.', id, cause);
}
