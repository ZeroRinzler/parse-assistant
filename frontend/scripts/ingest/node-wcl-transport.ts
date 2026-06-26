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

interface GraphQLResponse<TData> { data?: TData; errors?: Array<{ message: string }>; }

export class FetchWclTransport implements WclTransport {
  private readonly cache = new Map<string, Promise<unknown>>();

  /** Drop the in-process read cache (called between encounters to bound memory). */
  clearCache(): void {
    this.cache.clear();
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
    const body = await response.json() as GraphQLResponse<TData>;
    if (body.errors?.length) {
      throw new WclTransportError(body.errors[0]?.message || 'WCL GraphQL error', 0);
    }
    if (body.data === undefined) {
      throw new WclTransportError('WCL response had no data', 0);
    }
    return body.data;
  }
}
