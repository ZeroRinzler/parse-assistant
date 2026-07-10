import { EnvironmentProviders } from '@angular/core';
import { HttpRequest } from '@angular/common/http';
import { provideNgHttpCaching, NgHttpCachingMemoryStorage, NgHttpCachingHeaders, NG_HTTP_CACHING_YEAR_IN_MS } from 'ng-http-caching';
import { WCL_API_URL } from './wcl-transport';
import { REPORT_Q, REPORT_FIGHTS_Q, RATE_LIMIT_Q, CLASSES_Q, ENCOUNTERS_Q } from './wcl-queries';

/** Below the live-sync poll interval, so each tick sees a fresh pull while a tick's overlapping reads still share one fetch. */
export const WCL_LIVE_CACHE_MS = 10_000;

// Report reads are code-keyed, so they change as a live raid records pulls; discovery/budget reads
// must stay fresh. Everything else is fight-window-keyed (immutable) and keeps the long default.
const VOLATILE_QUERIES: ReadonlySet<string> = new Set([REPORT_Q, REPORT_FIGHTS_Q]);
const UNCACHED_QUERIES: ReadonlySet<string> = new Set([RATE_LIMIT_Q, CLASSES_Q, ENCOUNTERS_Q]);

/** The single place caching is decided, from the query alone - so nothing else branches on live/ingest state. */
export function wclCachingHeaders(query: string): Record<string, string> {
  if (UNCACHED_QUERIES.has(query)) return { [NgHttpCachingHeaders.DISALLOW_CACHE]: '1' };
  if (VOLATILE_QUERIES.has(query)) return { [NgHttpCachingHeaders.LIFETIME]: String(WCL_LIVE_CACHE_MS) };
  return {};
}

/**
 * Keyed on the GraphQL body so the renewing Authorization header can't fragment the cache. The
 * default lifetime is nominal-infinite because eviction is by scope: a page close drops the store,
 * and the ingest orchestrator clears it between encounters.
 */
export function provideWclCaching(): EnvironmentProviders {
  return provideNgHttpCaching({
    store: new NgHttpCachingMemoryStorage(),
    lifetime: NG_HTTP_CACHING_YEAR_IN_MS,
    allowedMethod: ['POST'],
    // undefined falls through to the library's default checks (DISALLOW_CACHE header,
    // allowedMethod); false hard-excludes every non-WCL request.
    isCacheable: (req: HttpRequest<unknown>) => (req.url === WCL_API_URL ? undefined : false),
    getKey: (req: HttpRequest<unknown>) =>
      req.url === WCL_API_URL ? `${req.method}@${req.url}@${JSON.stringify(req.body)}` : undefined,
  });
}
