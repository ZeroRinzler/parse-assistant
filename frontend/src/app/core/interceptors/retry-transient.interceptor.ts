import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { InjectionToken, inject } from '@angular/core';
import { retry, timer, throwError } from 'rxjs';

/**
 * The single retry point. One interceptor covers both the data-file GETs and the WCL
 * GraphQL POSTs because both ride Angular's `HttpClient`; the POSTs are reads, so retrying
 * is safe and the predicate gates on status, not verb. 401/403/404 pass through
 * un-retried: 401 is the WCL auth layer's to handle, 404 is the `missing` signal,
 * 403 is permanent.
 */
const BASE_DELAY_MS = 400;
const RETRYABLE_STATUSES = new Set([0, 408, 429, 500, 502, 503, 504]);

/**
 * Default 1: an interactive user can retry manually. The ingest environment provides 3 -
 * nothing sits behind an unattended run, and a swallowed parse fetch silently thins the bench.
 */
export const RETRY_MAX_ATTEMPTS = new InjectionToken<number>('RETRY_MAX_ATTEMPTS', { factory: () => 1 });

export const retryTransientInterceptor: HttpInterceptorFn = (req, next) => {
  const maxAttempts = inject(RETRY_MAX_ATTEMPTS);
  return next(req).pipe(
    retry({
      count: maxAttempts,
      // Return an observable to retry after the backoff, or rethrow to stop.
      delay: (error, retryCount) => {
        const status = error instanceof HttpErrorResponse ? error.status : -1;
        if (!RETRYABLE_STATUSES.has(status)) return throwError(() => error);
        return timer(BASE_DELAY_MS * 2 ** (retryCount - 1));
      },
    }),
  );
};
