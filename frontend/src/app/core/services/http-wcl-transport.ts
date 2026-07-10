import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { NgHttpCachingHeaders } from 'ng-http-caching';
import { WclTransport, WclTransportError, WCL_API_URL, WCL_UNUSABLE_STATUS } from './wcl-transport';

interface GraphQLResponse<TData> {
  data?: TData;
  errors?: { message: string }[];
}

/**
 * WCL transport: an `HttpClient` GraphQL POST. Caching lives in the ng-http-caching
 * interceptor (see `provideWclCaching`); `cacheFirst` only decides whether the request
 * opts out via the DISALLOW_CACHE header. The bearer is attached per request because
 * the token renews on expiry.
 */
@Injectable({ providedIn: 'root' })
export class HttpWclTransport implements WclTransport {
  private readonly http = inject(HttpClient);
  // A private log is only knowable by fetching it; the ingest orchestrator persists this
  // set so the next cheap signature check excludes it without re-fetching. Only
  // deterministic permission denials land here - a transient error must not stick a
  // usable log as inaccessible.
  private readonly inaccessibleCodes = new Set<string>();

  /** Return + clear the report codes that hit a permission-denied error since the last call. */
  takeInaccessibleCodes(): string[] {
    const codes = [...this.inaccessibleCodes];
    this.inaccessibleCodes.clear();
    return codes;
  }

  async query<TData>(gqlString: string, variables: object, token: string, cacheFirst: boolean): Promise<TData> {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (!cacheFirst) headers[NgHttpCachingHeaders.DISALLOW_CACHE] = '1';
    let body: GraphQLResponse<TData>;
    try {
      body = await firstValueFrom(this.http.post<GraphQLResponse<TData>>(
        WCL_API_URL,
        { query: gqlString, variables },
        { headers },
      ));
    } catch (error) {
      if (error instanceof HttpErrorResponse) {
        throw new WclTransportError(`WCL API error (${error.status})`, error.status);
      }
      throw error;
    }
    // A 200 with a GraphQL `errors` array (report not found, private, denied) never
    // improves on retry, so it classifies permanent, not transient.
    if (body.errors?.length) {
      const message = body.errors[0]?.message || 'WCL GraphQL error';
      const code = (variables as { code?: string }).code;
      if (code && /permission/i.test(message)) this.inaccessibleCodes.add(code);
      throw new WclTransportError(message, WCL_UNUSABLE_STATUS);
    }
    if (body.data === undefined) {
      throw new WclTransportError('WCL response had no data', WCL_UNUSABLE_STATUS);
    }
    return body.data;
  }
}
