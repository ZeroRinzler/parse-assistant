import { HttpErrorResponse } from '@angular/common/http';
import { Result, LoadError, missing, transient, permanent } from './result';
import { WclTransportError } from './services/wcl-transport';

// Status 0 is a network/CORS drop or the status-0 WclTransportError a GraphQL-level failure raises.
const TRANSIENT_STATUSES = new Set([0, 408, 429, 500, 502, 503, 504]);
const HTTP_NOT_FOUND = 404;

// Bound the cause-chain walk so a cyclic cause can never spin.
const MAX_CAUSE_DEPTH = 8;

// Walks `Error.cause` so a wrapped transport/HTTP error still classifies by its real status instead of the `permanent` fallback.
function statusOf(cause: unknown): number {
  let current: unknown = cause;
  for (let depth = 0; current != null && depth < MAX_CAUSE_DEPTH; depth++) {
    if (current instanceof HttpErrorResponse) return current.status;
    if (current instanceof WclTransportError) return current.status;
    current = current instanceof Error ? current.cause : null;
  }
  return -1;
}

// The single place an HTTP/transport status becomes a taxonomy variant, so slices never re-derive the mapping.
export function toLoadError(cause: unknown, id: string): Result<never, LoadError> {
  const status = statusOf(cause);

  if (status === HTTP_NOT_FOUND) return missing('Not yet ingested.');
  if (TRANSIENT_STATUSES.has(status)) return transient('WCL is unreachable right now.');
  return permanent('Analysis data could not be loaded.', id, cause);
}
