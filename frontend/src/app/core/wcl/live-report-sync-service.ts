// Components stay purely declarative: they `switchMap` onto `pollTriggers()` and handle the actual network call themselves.
import { DOCUMENT } from '@angular/common';
import { Injectable, inject } from '@angular/core';
import { Observable, fromEvent, interval, merge } from 'rxjs';
import { filter, map } from 'rxjs/operators';

export const POLL_INTERVAL_S = 12;

@Injectable({ providedIn: 'root' })
export class LiveReportSyncService {
  private readonly document = inject(DOCUMENT);

  // Also fires on tab refocus, provided POLL_INTERVAL_S has elapsed since the last emission, to avoid a double-poll right after a scheduled tick.
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
