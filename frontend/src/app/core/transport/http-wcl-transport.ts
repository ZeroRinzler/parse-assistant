import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { FetchOutcomes, WclTransport, WclTransportError, WCL_API_URL, WCL_UNUSABLE_STATUS } from '../services/wcl-transport';
import { wclCachingHeaders } from '../services/wcl-caching';

interface GraphQLResponse<TData> {
  data?: TData;
  errors?: { message: string }[];
}

interface OpenScope {
  inaccessibleCodes: Set<string>;
  failedCodes: Set<string>;
}

// The bearer is attached per request because the token renews on expiry.
@Injectable({ providedIn: 'root' })
export class HttpWclTransport implements WclTransport {
  private readonly http = inject(HttpClient);
  private scope: OpenScope | null = null;

  async withFetchOutcomes<T>(run: () => Promise<T>): Promise<{ result: T; outcomes: FetchOutcomes }> {
    const enclosing = this.scope;
    const outcomes: OpenScope = { inaccessibleCodes: new Set(), failedCodes: new Set() };
    this.scope = outcomes;
    try {
      return { result: await run(), outcomes };
    } finally {
      this.scope = enclosing;
    }
  }

  private recordFailure(code: string | undefined, denied = false): void {
    if (!code || !this.scope) return;
    this.scope.failedCodes.add(code);
    if (denied) this.scope.inaccessibleCodes.add(code);
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
        if (error.status !== 401) this.recordFailure(code);
        throw new WclTransportError(`WCL API error (${error.status})`, error.status);
      }
      throw error;
    }
    return this.usableData(body, code);
  }

  private usableData<TData>(body: GraphQLResponse<TData>, code: string | undefined): TData {
    // A 200 with a GraphQL `errors` array never improves on retry, so it classifies permanent, not transient.
    if (body.errors?.length) {
      const message = body.errors[0]?.message ?? 'WCL GraphQL error';
      this.recordFailure(code, /permission/i.test(message));
      throw new WclTransportError(message, WCL_UNUSABLE_STATUS);
    }
    if (body.data === undefined) {
      this.recordFailure(code);
      throw new WclTransportError('WCL response had no data', WCL_UNUSABLE_STATUS);
    }
    return body.data;
  }
}
