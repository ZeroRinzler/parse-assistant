import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { InjectionToken, inject } from '@angular/core';
import { retry, timer, throwError } from 'rxjs';

// 401/403/404 pass through un-retried: 401 is the WCL auth layer's to handle, 404 is the `missing` signal, 403 is permanent.
const BASE_DELAY_MS = 400;
const RETRYABLE_STATUSES = new Set([0, 408, 429, 500, 502, 503, 504]);

// Default 1: an interactive user can retry manually. The ingest environment provides 3 so a swallowed parse fetch doesn't silently thin the bench.
export const RETRY_MAX_ATTEMPTS = new InjectionToken<number>('RETRY_MAX_ATTEMPTS', { factory: () => 1 });

export const retryTransientInterceptor: HttpInterceptorFn = (req, next) => {
  const maxAttempts = inject(RETRY_MAX_ATTEMPTS);
  return next(req).pipe(
    retry({
      count: maxAttempts,
      delay: (error: unknown, retryCount) => {
        const status = error instanceof HttpErrorResponse ? error.status : -1;
        if (!RETRYABLE_STATUSES.has(status)) return throwError(() => error);
        return timer(BASE_DELAY_MS * 2 ** (retryCount - 1));
      },
    }),
  );
};
