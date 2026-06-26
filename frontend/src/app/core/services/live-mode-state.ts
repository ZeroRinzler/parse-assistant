import { Injectable, signal } from '@angular/core';

/**
 * Whether the post-raid page is currently live-syncing (polling for new pulls). When true,
 * WclApiService reads the report/event streams network-only so a poll sees freshly-recorded
 * fights; when false (a saved, immutable report) those reads are cache-first - the report is
 * fetched once and re-selecting a fight/player is free. Lives in its own dependency-light
 * service so the transport can read it without coupling to the polling-timer service.
 */
@Injectable({ providedIn: 'root' })
export class LiveModeState {
  readonly active = signal(false);
}
