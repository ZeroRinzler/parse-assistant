import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { Apollo, gql } from 'apollo-angular';
import { ServerError, CombinedGraphQLErrors, type FetchPolicy, type OperationVariables } from '@apollo/client';
import { WclTransport, WclTransportError, WCL_UNUSABLE_STATUS } from './wcl-transport';

/**
 * Browser WCL transport: apollo-angular. Lives in its own file (not `wcl-transport.ts`)
 * so the dependency-light transport module stays importable in the headless Node
 * ingestion - apollo-angular is a partially-compiled library that needs the JIT
 * compiler just to load, so it must never enter the Node import graph.
 *
 * Attaches the bearer per request via operation context (it must not be baked into the
 * link, since it is renewed on expiry) and maps Apollo's error shapes to
 * {@link WclTransportError}.
 */
@Injectable({ providedIn: 'root' })
export class ApolloWclTransport implements WclTransport {
  private readonly apollo = inject(Apollo);

  async query<TData>(gqlString: string, variables: object, token: string, cacheFirst: boolean): Promise<TData> {
    const fetchPolicy: FetchPolicy = cacheFirst ? 'cache-first' : 'network-only';
    try {
      const result = await firstValueFrom(this.apollo.query<TData, OperationVariables>({
        query: gql(gqlString),
        variables: variables as OperationVariables,
        fetchPolicy,
        context: { headers: { Authorization: `Bearer ${token}` } },
      }));
      return result.data as TData;
    } catch (error) {
      // apollo-angular maps a non-2xx HTTP response to ServerError (with statusCode).
      if (ServerError.is(error)) {
        throw new WclTransportError(`WCL API error (${error.statusCode})`, error.statusCode);
      }
      // A 200 with a top-level `errors` array (report not found, private, denied) surfaces as
      // CombinedGraphQLErrors. Retrying can't help, so classify permanent, not transient.
      if (CombinedGraphQLErrors.is(error)) {
        throw new WclTransportError(error.errors[0]?.message || 'WCL GraphQL error', WCL_UNUSABLE_STATUS);
      }
      throw error;
    }
  }
}
