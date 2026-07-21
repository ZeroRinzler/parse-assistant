import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { WclTransport, WclTransportError, WCL_API_URL, WCL_UNUSABLE_STATUS } from './wcl-transport';
import { wclCachingHeaders } from './wcl-caching';

interface GraphQLResponse<TData> {
  data?: TData;
  errors?: { message: string }[];
}

/**
 * WCL GraphQL transport (`HttpClient` POST). The bearer is attached per request because the token
 * renews on expiry; the query's cache-control headers come from `wclCachingHeaders`.
 */
@Injectable({ providedIn: 'root' })
export class HttpWclTransport implements WclTransport {
  private readonly http = inject(HttpClient);
  // A private log is only knowable by fetching it; the ingest orchestrator persists this
  // set so the next cheap signature check excludes it without re-fetching. Only
  // deterministic permission denials land here - a transient error must not stick a
  // usable log as inaccessible.
  private readonly inaccessibleCodes = new Set<string>();
  // Every code-bearing fetch that failed this run (permission + transient), so the stamp keys on the parses actually used.
  private readonly failedCodes = new Set<string>();

  /** Return + clear the report codes that hit a permission-denied error since the last call. */
  takeInaccessibleCodes(): string[] {
    const codes = [...this.inaccessibleCodes];
    this.inaccessibleCodes.clear();
    return codes;
  }

  /** Return + clear every report code whose fetch failed since the last call. */
  takeFailedCodes(): string[] {
    const codes = [...this.failedCodes];
    this.failedCodes.clear();
    return codes;
  }

  async query<TData>(gqlString: string, variables: object, token: string): Promise<TData> {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, ...wclCachingHeaders(gqlString) };
    const code = (variables as { code?: string }).code;
    let body: GraphQLResponse<TData>;
    try {
      body = await firstValueFrom(this.http.post<GraphQLResponse<TData>>(
        WCL_API_URL,
        { query: gqlString, variables },
        { headers },
      ));
    } catch (error) {
      if (error instanceof HttpErrorResponse) {
        // 401 is the auth layer's to retry; any other HTTP error has spent the transient-retry interceptor.
        if (code && error.status !== 401) this.failedCodes.add(code);
        throw new WclTransportError(`WCL API error (${error.status})`, error.status);
      }
      throw error;
    }
    // A 200 with a GraphQL `errors` array (report not found, private, denied) never
    // improves on retry, so it classifies permanent, not transient.
    if (body.errors?.length) {
      const message = body.errors[0]?.message || 'WCL GraphQL error';
      if (code) {
        this.failedCodes.add(code);
        if (/permission/i.test(message)) this.inaccessibleCodes.add(code);
      }
      throw new WclTransportError(message, WCL_UNUSABLE_STATUS);
    }
    if (body.data === undefined) {
      if (code) this.failedCodes.add(code);
      throw new WclTransportError('WCL response had no data', WCL_UNUSABLE_STATUS);
    }
    return body.data;
  }
}
