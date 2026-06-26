/**
 * Extract layer - WCL transport contract.
 *
 * The v5 ingestion no longer ships its own GraphQL/OAuth client: every WCL read goes
 * through the shared Angular `WclApiService` (over the Node `FetchWclTransport`),
 * which the orchestrator adapts to this `WclQueryClient` interface so the one
 * surviving discovery fetcher (`getEncounters`) and the budget gate can stay
 * transport-agnostic and testable with a fake.
 */

import type { WclResourceEvent } from './models/wcl.models.ts';

/** Options accepted by the event-fetching helpers. */
export interface EventFetchOptions {
  sourceId?: number;
  targetId?: number;
  includeResources?: boolean;
  hostilityType?: string;
}

/**
 * The transport surface the discovery fetcher + orchestrator depend on. Declaring it
 * as an interface (rather than a concrete class) lets the orchestrator implement it
 * over `WclApiService` and lets tests inject a fake client with no real OAuth/HTTP.
 */
export interface WclQueryClient {
  query<T = unknown, TVars extends object = Record<string, never>>(gql: string, variables?: TVars): Promise<T>;
  getAllEvents(code: string, fightId: number, dataType: string, startTime: number, endTime: number, options?: EventFetchOptions): Promise<WclResourceEvent[]>;
  resolveServerSlug(serverId: number): Promise<[string, string]>;
  assertBudget(margin: number): Promise<void>;
}

// Thrown when the WCL hourly point budget is (about to be) exhausted. The ingest
// loop catches this to stop cleanly and commit partial progress; the remaining work
// is picked up on the next run. We do NOT retry: the limit resets on an hourly
// boundary and an hourly task must not stall waiting for it.
export class BudgetExceededError extends Error {
  override name = 'BudgetExceededError';
  constructor(message: string) { super(message); }
}
