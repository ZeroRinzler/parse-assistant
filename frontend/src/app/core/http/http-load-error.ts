import { HttpErrorResponse } from '@angular/common/http';
import { Result, Results } from './result';
import { WclTransportError } from '../wcl/wcl-transport';

// Status 0 is a network/CORS drop or the status-0 WclTransportError a GraphQL-level failure raises.
const TRANSIENT_STATUSES = new Set([0, 408, 429, 500, 502, 503, 504]);
const HTTP_NOT_FOUND = 404;

// Bound the cause-chain walk so a cyclic cause can never spin.
const MAX_CAUSE_DEPTH = 8;

export class HttpLoadErrors {
  private constructor() {}

  // Walks `Error.cause` so a wrapped transport/HTTP error still classifies by its real status instead of the `permanent` fallback.
  private static statusOf(cause: unknown): number {
    let current: unknown = cause;
    for (let depth = 0; current != null && depth < MAX_CAUSE_DEPTH; depth++) {
      if (current instanceof HttpErrorResponse) return current.status;
      if (current instanceof WclTransportError) return current.status;
      current = current instanceof Error ? current.cause : null;
    }
    return -1;
  }

  // The single place an HTTP/transport status becomes a taxonomy variant, so slices never re-derive the mapping.
  static toLoadError(cause: unknown, id: string): Result<never> {
    const status = HttpLoadErrors.statusOf(cause);

    if (status === HTTP_NOT_FOUND) return Results.missing('Not yet ingested.');
    if (TRANSIENT_STATUSES.has(status)) return Results.transient('WCL is unreachable right now.');
    return Results.permanent('Analysis data could not be loaded.', id, cause);
  }
}
