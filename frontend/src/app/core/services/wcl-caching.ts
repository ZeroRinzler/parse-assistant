import { EnvironmentProviders } from '@angular/core';
import { HttpRequest } from '@angular/common/http';
import { provideNgHttpCaching, NgHttpCachingMemoryStorage, NG_HTTP_CACHING_YEAR_IN_MS } from 'ng-http-caching';
import { WCL_API_URL } from './wcl-transport';

/**
 * The WCL response cache: dedupes cache-first reads so the five slice cards share one
 * report/event fetch per session. Only WCL_API_URL POSTs are cacheable, keyed on the
 * GraphQL body so the renewing Authorization header cannot fragment the cache. Lifetime
 * is nominal-infinite because eviction is by scope: a page close drops the store, and
 * the ingest orchestrator clears it between encounters to bound memory.
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
