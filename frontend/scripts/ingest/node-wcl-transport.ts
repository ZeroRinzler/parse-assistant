/**
 * Node WCL transport: a plain-`fetch` GraphQL client implementing the same
 * `WclTransport` the browser fills with apollo-angular (which does not run headless).
 * So `WclApiService` and every `*TransformService` above it are identical in the
 * browser and in ingestion - only this low-level transport differs.
 *
 * `cacheFirst` reads are memoised in-process by {query+vars}, which is what makes the
 * 5 transforms share one fetch per report/event stream within a run (the "same
 * caching"). `network-only` reads always hit the wire.
 */
import { WCL_API_URL, WclTransportError, type WclTransport } from '../../src/app/core/services/wcl-transport.ts';
import { logWarn } from '../../src/app/core/log.ts';

interface GraphQLResponse<TData> { data?: TData; errors?: { message: string }[]; }

// Mirrors the browser retry interceptor's RETRYABLE_STATUSES.
const RETRYABLE_STATUSES = new Set([0, 408, 429, 500, 502, 503, 504]);
// More than the browser's single retry: nothing runs headless to retry for us, and a swallowed
// parse fetch silently thins the bench, so ingestion rides out a longer blip.
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 500;

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class FetchWclTransport implements WclTransport {
  private readonly cache = new Map<string, Promise<unknown>>();
  // Report codes that returned a "no permission" GraphQL error this run. A private/
  // inaccessible log is only knowable by fetching it, so we record it here when the fetch
  // reveals it; the orchestrator persists the set so later cheap hash checks can exclude
  // these logs without re-fetching. Only deterministic permission denials land here -
  // never transient network/HTTP errors (which must not stick a usable log as inaccessible).
  private readonly inaccessibleCodes = new Set<string>();

  /** Drop the in-process read cache (called between encounters to bound memory). */
  clearCache(): void {
    this.cache.clear();
  }

  /** Return + clear the report codes that hit a permission-denied error since the last call. */
  takeInaccessibleCodes(): string[] {
    const codes = [...this.inaccessibleCodes];
    this.inaccessibleCodes.clear();
    return codes;
  }

  async query<TData>(gqlString: string, variables: object, token: string, cacheFirst: boolean): Promise<TData> {
    const key = cacheFirst ? `${gqlString}::${JSON.stringify(variables)}` : '';
    if (cacheFirst) {
      const hit = this.cache.get(key);
      if (hit) return hit as Promise<TData>;
    }
    const promise = this.run<TData>(gqlString, variables, token);
    if (cacheFirst) this.cache.set(key, promise);
    return promise;
  }

  private async run<TData>(gqlString: string, variables: object, token: string): Promise<TData> {
    const body = await this.fetchWithRetry<TData>(gqlString, variables, token);
    if (body.errors?.length) {
      const message = body.errors[0]?.message || 'WCL GraphQL error';
      // A "no permission to view this report" rejection marks the report as inaccessible.
      const code = (variables as { code?: string }).code;
      if (code && /permission/i.test(message)) this.inaccessibleCodes.add(code);
      throw new WclTransportError(message, 0);
    }
    if (body.data === undefined) {
      throw new WclTransportError('WCL response had no data', 0);
    }
    return body.data;
  }

  /**
   * Retries only the network + HTTP layer, so a semantic 200 (a GraphQL error, handled by the
   * caller) is never retried. Logs the final give-up, since the caller swallows it to a
   * silently dropped parse.
   */
  private async fetchWithRetry<TData>(gqlString: string, variables: object, token: string): Promise<GraphQLResponse<TData>> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.fetchOnce<TData>(gqlString, variables, token);
      } catch (err) {
        const status = err instanceof WclTransportError ? err.status : -1;
        if (RETRYABLE_STATUSES.has(status) && attempt < MAX_RETRIES) {
          await delay(BASE_DELAY_MS * 2 ** attempt);
          continue;
        }
        if (RETRYABLE_STATUSES.has(status)) {
          logWarn(`FetchWclTransport: giving up after ${MAX_RETRIES} retries`, err);
        }
        throw err;
      }
    }
  }

  private async fetchOnce<TData>(gqlString: string, variables: object, token: string): Promise<GraphQLResponse<TData>> {
    let response: Response;
    try {
      response = await fetch(WCL_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ query: gqlString, variables }),
      });
    } catch (err) {
      throw new WclTransportError(`WCL network error: ${(err as Error).message}`, 0);
    }
    if (!response.ok) {
      throw new WclTransportError(`WCL API error (${response.status})`, response.status);
    }
    return await response.json() as GraphQLResponse<TData>;
  }
}
