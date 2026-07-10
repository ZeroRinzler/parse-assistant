import { InjectionToken } from '@angular/core';

/**
 * Single source of truth for the WCL GraphQL endpoint. The app authenticates with
 * the client-credentials grant, so it targets the `/client` endpoint.
 */
export const WCL_API_URL = 'https://www.warcraftlogs.com/api/v2/client';

/**
 * Normalised transport error so `WclApiService` can react to auth failures without
 * knowing the underlying GraphQL client. `status` is the HTTP status when known
 * (e.g. 401 for a rejected token), or 0 for a GraphQL-level / network error.
 */
export class WclTransportError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'WclTransportError';
  }
}

/**
 * Synthetic status for a WCL 200 that is semantically unusable (a GraphQL error or a null
 * report), so `toLoadError` classifies it `permanent`: retrying a missing/private/expired
 * report never helps. 422 because a client-error status is never in the retryable set.
 */
export const WCL_UNUSABLE_STATUS = 422;

/**
 * The low-level GraphQL transport `WclApiService` delegates to - an interface (not the
 * concrete {@link HttpWclTransport}) so specs can fake it through the token.
 */
export interface WclTransport {
  /** Runs the GraphQL POST; caching is the query's own concern (`wclCachingHeaders`). Throws {@link WclTransportError} on failure. */
  query<TData>(gqlString: string, variables: object, token: string): Promise<TData>;
}

export const WCL_TRANSPORT = new InjectionToken<WclTransport>('WCL_TRANSPORT');
