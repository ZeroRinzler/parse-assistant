/**
 * Extract layer - WCL v2 transport.
 *
 * Owns OAuth2 client-credentials auth, the GraphQL request wrapper, rate-limit /
 * budget tracking, and cursor-paginated event fetching. Query strings come from
 * wcl-queries.ts; response-to-model mapping lives in wcl-mappers.ts; high-level
 * `get*` fetchers live in wcl-fetchers.ts. This file contains no analysis or
 * filesystem logic.
 */

import { GraphQLClient, ClientError } from 'graphql-request';
import { logWarn } from '../../src/app/core/log.ts';
import { EVENTS_QUERY, RATE_LIMIT_QUERY, SERVER_QUERY, type EventsQueryVars, type ServerQueryVars } from './wcl-queries.ts';
import type { WclRateLimitData, WclResourceEvent } from './models/wcl.models.ts';

const WCL_TOKEN_URL = 'https://www.warcraftlogs.com/oauth/token';
const WCL_API_URL = 'https://www.warcraftlogs.com/api/v2/client';

/** Options accepted by the event-fetching helpers. */
export interface EventFetchOptions {
  sourceId?: number;
  targetId?: number;
  includeResources?: boolean;
  hostilityType?: string;
}

/**
 * The transport surface the high-level fetchers depend on. Declaring it as an
 * interface (rather than the concrete class) lets tests inject a fake client with
 * no real OAuth/HTTP.
 */
export interface WclQueryClient {
  query<T = unknown, TVars extends object = Record<string, never>>(gql: string, variables?: TVars): Promise<T>;
  getAllEvents(code: string, fightId: number, dataType: string, startTime: number, endTime: number, options?: EventFetchOptions): Promise<WclResourceEvent[]>;
  resolveServerSlug(serverId: number): Promise<[string, string]>;
}

// Thrown when the WCL hourly point budget is (about to be) exhausted. The ingest
// loop catches this to stop cleanly and commit partial progress; the remaining work
// is picked up on the next run. We do NOT retry: the limit resets on an hourly
// boundary and an hourly task must not stall waiting for it.
export class BudgetExceededError extends Error {
  override name = 'BudgetExceededError';
  constructor(message: string) { super(message); }
}

export class WCLClient implements WclQueryClient {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private _token: string | null = null;
  private _tokenExpiry = 0;
  private readonly _serverSlugCache = new Map<number, [string, string]>();
  private _limitPerHour: number | null = null;
  private _pointsSpentThisHour = 0;
  private readonly _client = new GraphQLClient(WCL_API_URL);

  constructor() {
    this.clientId = process.env['WCL_CLIENT_ID'] ?? '';
    this.clientSecret = process.env['WCL_CLIENT_SECRET'] ?? '';
    if (!this.clientId || !this.clientSecret) {
      throw new Error('WCL_CLIENT_ID and WCL_CLIENT_SECRET environment variables must be set');
    }
  }

  private async _getToken(): Promise<string> {
    if (this._token && Date.now() / 1000 < this._tokenExpiry - 60) {
      return this._token;
    }
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });
    const response = await fetch(WCL_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OAuth2 token error ${response.status}: ${text.slice(0, 200)}`);
    }
    const data = await response.json() as { access_token: string; expires_in?: number };
    this._token = data.access_token;
    this._tokenExpiry = Date.now() / 1000 + (data.expires_in ?? 3600);
    return this._token;
  }

  async query<T = unknown, TVars extends object = Record<string, never>>(gql: string, variables?: TVars): Promise<T> {
    const token = await this._getToken();
    try {
      // graphql-request returns the GraphQL `data` payload directly and throws a
      // ClientError both on a non-2xx HTTP status and on a 200 response that carries
      // a top-level `errors` array, so all error handling lives in the catch below.
      return await this._client.request<T>(gql, (variables ?? {}) as object, { Authorization: `Bearer ${token}` });
    } catch (err) {
      if (err instanceof ClientError) {
        const status = err.response.status;
        const errText = JSON.stringify(err.response.errors ?? err.response);
        if (status === 429 || /rate.?limit|too many requests|exhausted/i.test(errText)) {
          throw new BudgetExceededError(`WCL rate limit: ${errText.slice(0, 200)}`);
        }
        throw new Error(`WCL API error ${status}: ${errText.slice(0, 300)}`);
      }
      throw err;
    }
  }

  // Reads the live hourly point budget and caches it on the instance.
  async getRateLimit(): Promise<{ limitPerHour: number | null; pointsSpentThisHour: number; pointsResetIn: number | null }> {
    const data = await this.query<{ rateLimitData?: WclRateLimitData }>(RATE_LIMIT_QUERY);
    const rateLimit = data.rateLimitData ?? {};
    if (rateLimit.limitPerHour != null) this._limitPerHour = rateLimit.limitPerHour;
    if (rateLimit.pointsSpentThisHour != null) this._pointsSpentThisHour = rateLimit.pointsSpentThisHour;
    return { limitPerHour: this._limitPerHour, pointsSpentThisHour: this._pointsSpentThisHour, pointsResetIn: rateLimit.pointsResetIn ?? null };
  }

  // Fetches live budget then throws BudgetExceededError if remaining points < margin.
  async assertBudget(margin: number): Promise<void> {
    const { limitPerHour, pointsSpentThisHour } = await this.getRateLimit();
    if (limitPerHour == null) return; // unknown - don't block
    const remaining = limitPerHour - pointsSpentThisHour;
    if (remaining < margin) {
      throw new BudgetExceededError(
        `WCL budget low: ${remaining} of ${limitPerHour} remaining (need ${margin})`,
      );
    }
  }

  // Streams WCL event pages via cursor pagination, yielding one page at a time. The
  // generator owns only the cursor (`nextPageTimestamp`); accumulation is the
  // caller's concern, so deep pagination never builds a growing array in here.
  async *getEventPages(
    code: string, fightId: number, dataType: string,
    startTime: number, endTime: number, options: EventFetchOptions = {},
  ): AsyncGenerator<WclResourceEvent[]> {
    let currentStart = startTime;
    while (true) {
      const variables: EventsQueryVars = { code, fightIDs: [fightId], dataType, startTime: currentStart, endTime };
      if (options.sourceId != null) variables.sourceID = options.sourceId;
      if (options.targetId != null) variables.targetID = options.targetId;
      if (options.includeResources) variables.includeResources = true;
      if (options.hostilityType) variables.hostilityType = options.hostilityType;
      const data = await this.query<{
        reportData: { report: { events: { data: WclResourceEvent[]; nextPageTimestamp?: number | null } } }
      }, EventsQueryVars>(EVENTS_QUERY, variables);
      const page = data.reportData.report.events;
      if (page.data?.length) yield page.data;
      if (page.nextPageTimestamp == null) break;
      currentStart = page.nextPageTimestamp;
    }
  }

  // Thin accumulator over getEventPages for callers that want the full event list.
  async getAllEvents(
    code: string, fightId: number, dataType: string,
    startTime: number, endTime: number, options: EventFetchOptions = {},
  ): Promise<WclResourceEvent[]> {
    const events: WclResourceEvent[] = [];
    for await (const page of this.getEventPages(code, fightId, dataType, startTime, endTime, options)) {
      events.push(...page);
    }
    return events;
  }

  async resolveServerSlug(serverId: number): Promise<[string, string]> {
    const cached = this._serverSlugCache.get(serverId);
    if (cached) return cached;
    try {
      const data = await this.query<{ worldData: { server?: { slug?: string; region?: { slug?: string } } } }, ServerQueryVars>(SERVER_QUERY, { id: serverId });
      const server = data.worldData.server ?? {};
      const result: [string, string] = [(server.slug ?? '').toLowerCase(), ((server.region?.slug) ?? '').toLowerCase()];
      this._serverSlugCache.set(serverId, result);
      return result;
    } catch (err) {
      logWarn(`resolveServerSlug(${serverId})`, err);
      this._serverSlugCache.set(serverId, ['', '']);
      return ['', ''];
    }
  }
}
