/**
 * LiveReportSyncService
 *
 * Owns the visibility-aware polling timer used by the live-sync feature.
 * Components stay purely declarative: they `switchMap` onto `pollTriggers()`
 * and handle the actual network call themselves.
 *
 * Polling interval: every POLL_INTERVAL_S while the tab is visible, plus an
 * immediate refocus tick when the user returns to the tab (subject to the same
 * interval cooldown to avoid double-polls right after a scheduled tick).
 */
import { DOCUMENT } from '@angular/common';
import { Injectable, inject } from '@angular/core';
import { Observable, fromEvent, interval, merge } from 'rxjs';
import { filter, map } from 'rxjs/operators';

export const POLL_INTERVAL_S = 12;

@Injectable({ providedIn: 'root' })
export class LiveReportSyncService {
  private readonly document = inject(DOCUMENT);

  /**
   * Returns an Observable that emits whenever a poll should be attempted.
   * The returned stream:
   * - Fires immediately on subscription (the first tick).
   * - Then fires every POLL_INTERVAL_S while the tab is visible.
   * - Also fires on tab refocus, provided POLL_INTERVAL_S has elapsed since
   *   the last emission (prevents a double-poll right after a scheduled tick).
   *
   * Callers should `switchMap` this into their own pipeline and apply
   * `exhaustMap` to drop overlapping poll attempts.
   */
  pollTriggers(): Observable<void> {
    const isVisible = () => this.document.visibilityState === 'visible';
    let lastEmitAt = 0;

    const tick$ = interval(POLL_INTERVAL_S * 1000).pipe(filter(isVisible));

    const refocus$ = fromEvent(this.document, 'visibilitychange').pipe(
      filter(() => isVisible() && Date.now() - lastEmitAt >= POLL_INTERVAL_S * 1000),
    );

    return merge(tick$, refocus$).pipe(
      map(() => { lastEmitAt = Date.now(); }),
    );
  }
}
