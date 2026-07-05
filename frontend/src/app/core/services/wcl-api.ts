import { Injectable, inject } from '@angular/core';
import { WclAuthService } from './wcl-auth';
import { LiveModeState } from './live-mode-state';
import { WCL_TRANSPORT, WCL_INGEST_MODE, WclTransportError } from './wcl-transport';
import {
  WclReport, WclEvent,
  PlayerDetailGroups, WclRankingsBlob, WclRawAbility, WclCombatantInfo, WclTableBlob,
} from '../models/wcl.models';
import {
  REPORT_Q, PLAYER_DETAILS_Q, EVENTS_Q,
  COMBATANT_INFO_Q, RANKINGS_Q, TABLE_Q, RESURRECTS_Q, buildGearNamesQuery, buildAbilityIconsQuery,
  ReportQueryVars, PlayerDetailsQueryVars,
  EventsQueryVars, CombatantInfoQueryVars, RankingsQueryVars, TableQueryVars, ResurrectsQueryVars,
} from './wcl-queries';
import { specMetaOf } from '../spec-meta';

@Injectable({ providedIn: 'root' })
export class WclApiService {
  private readonly auth = inject(WclAuthService);
  private readonly transport = inject(WCL_TRANSPORT);
  private readonly ingestMode = inject(WCL_INGEST_MODE);
  private readonly liveMode = inject(LiveModeState);

  /**
   * Fetch policy for the otherwise per-pull report/event reads. Ingestion shares one fetch
   * across the 5 transforms (cache-first). In the browser a saved report is immutable, so
   * those reads are cache-first too - the report is fetched once and re-selecting a
   * fight/player is free; only while live-syncing do they go network-only so a poll sees
   * newly-recorded fights.
   */
  private livePolicy(): 'cache-first' | 'network-only' {
    return this.ingestMode || !this.liveMode.active() ? 'cache-first' : 'network-only';
  }

  /**
   * Runs a GraphQL query against WCL through the injected transport (Apollo in the
   * browser, plain fetch in Node ingestion). The client-credentials bearer token is
   * fetched here and passed per request (it is renewed on expiry). `fetchPolicy`
   * defaults to `cache-first` to dedupe repeat reads within a session; callers that
   * must always see fresh data (report polling, large event fetches) pass `network-only`.
   * On a 401 the cached token is dropped so the next request re-authenticates.
   */
  async query<TData = unknown>(
    gqlString: string, variables: object = {}, fetchPolicy: 'cache-first' | 'network-only' = 'cache-first',
  ): Promise<TData> {
    const token = await this.auth.getToken();
    try {
      return await this.transport.query<TData>(gqlString, variables, token, fetchPolicy === 'cache-first');
    } catch (error) {
      if (error instanceof WclTransportError && error.status === 401) {
        // Token was rejected (e.g. expired early or the secret was rotated); drop the
        // cached token so the next request fetches a fresh one.
        this.auth.invalidate();
        throw new Error('WCL API error (401) - token rejected.', { cause: error });
      }
      throw error instanceof WclTransportError ? new Error(error.message, { cause: error }) : error;
    }
  }

  async getReport(code: string): Promise<WclReport> {
    const vars: ReportQueryVars = { code };
    // Saved reports are immutable, so the read is cache-first (see livePolicy); only while
    // live-syncing does it go network-only, so a poll never hides newly-recorded fights.
    const result = await this.query<{ reportData: { report: WclReport } }>(REPORT_Q, vars, this.livePolicy());
    return result.reportData.report;
  }

  /** Raw `playerDetails` groups (dps / healers / tanks / unknown). Consumers map to spec. */
  async getPlayerDetails(code: string, fightId: number): Promise<PlayerDetailGroups> {
    const vars: PlayerDetailsQueryVars = { code, fightIDs: [fightId] };
    const result = await this.query<{ reportData: { report: { playerDetails: { data: { playerDetails: PlayerDetailGroups } } } } }>(
      PLAYER_DETAILS_Q, vars,
    );
    return result.reportData.report.playerDetails.data.playerDetails;
  }

  async getAllEvents(
    code: string, fightId: number, dataType: string,
    startTime: number, endTime: number, sourceId?: number,
    includeResources = false, hostilityType?: 'Friendlies' | 'Enemies',
  ): Promise<WclEvent[]> {
    const events: WclEvent[] = [];
    let currentStart = startTime;
    for (;;) {
      const vars: EventsQueryVars = { code, fightIDs: [fightId], dataType, startTime: currentStart, endTime };
      if (sourceId != null) vars.sourceID = sourceId;
      if (includeResources) vars.includeResources = true;
      if (hostilityType) vars.hostilityType = hostilityType;
      // Event pages for a saved report are immutable, so the read is cache-first (see
      // livePolicy) - re-analysis is served from cache; only while live-syncing does it go
      // network-only, so the still-recording fight's events are always fresh.
      const result = await this.query<{ reportData: { report: { events: { data: WclEvent[]; nextPageTimestamp?: number } } } }>(
        EVENTS_Q, vars, this.livePolicy(),
      );
      const page = result.reportData.report.events;
      events.push(...(page.data ?? []));
      if (!page.nextPageTimestamp) break;
      currentStart = page.nextPageTimestamp;
    }
    return events;
  }

  /**
   * Raw CombatantInfo events for one player actor in a fight (gear + talentTree).
   * Returns the events array as WCL returns it (empty when the log carries none);
   * consumers pick the player's event (see `selectCombatantInfo`), extract gear /
   * talents, and resolve names (see `getGameNames`).
   */
  async getCombatantInfo(code: string, fightId: number, playerId: number): Promise<WclCombatantInfo[]> {
    const vars: CombatantInfoQueryVars = { code, fightIDs: [fightId], sourceID: playerId };
    const result = await this.query<{ reportData: { report: { events: { data: WclCombatantInfo[] } } } }>(
      COMBATANT_INFO_Q, vars,
    );
    return result?.reportData?.report?.events?.data ?? [];
  }

  /**
   * Raw damage-done summary table for a fight (JSON blob, string or object). Consumers
   * pick their player's `data.entries` row by actor id and derive DPS from `total` over
   * the fight duration. Cache-first per `livePolicy` (a saved report's table is immutable).
   */
  async getDamageDoneTable(code: string, fightId: number): Promise<WclTableBlob | null> {
    const vars: TableQueryVars = { code, fightIDs: [fightId], dataType: 'DamageDone' };
    const result = await this.query<{ reportData: { report: { table: WclTableBlob } } }>(
      TABLE_Q, vars, this.livePolicy(),
    );
    return result?.reportData?.report?.table ?? null;
  }

  /**
   * Resurrect events (type `resurrect`) for a fight - who was brought back and when - so the
   * wipe analysis can tell when a dead player is alive again. WCL has no `Resurrects` data
   * type, so this scans `All` with a server-side `type` filter (only matches come back).
   */
  async getResurrects(code: string, fightId: number, startTime: number, endTime: number): Promise<WclEvent[]> {
    const events: WclEvent[] = [];
    let currentStart = startTime;
    for (;;) {
      const vars: ResurrectsQueryVars = { code, fightIDs: [fightId], filter: 'type = "resurrect"', startTime: currentStart, endTime };
      const result = await this.query<{ reportData: { report: { events: { data: WclEvent[]; nextPageTimestamp?: number } } } }>(
        RESURRECTS_Q, vars, this.livePolicy(),
      );
      const page = result.reportData.report.events;
      events.push(...(page.data ?? []));
      if (!page.nextPageTimestamp) break;
      currentStart = page.nextPageTimestamp;
    }
    return events;
  }

  /**
   * Resolve item + enchant names by ID in one batched gameData round-trip. Returns
   * the raw aliased map (`i<itemId>` / `e<enchantId>` -> { id, name }); names may
   * carry HTML entities, so consumers decode them.
   */
  async getGameNames(itemIds: number[], enchantIds: number[]): Promise<Record<string, { id: number; name: string }>> {
    if (!itemIds.length && !enchantIds.length) return {};
    const result = await this.query<{ gameData: Record<string, { id: number; name: string }> }>(
      buildGearNamesQuery(itemIds, enchantIds),
    );
    return result?.gameData ?? {};
  }

  /**
   * Resolve each spell id via `gameData.ability(id)` in one batched round-trip.
   * Returns the raw aliased `gameData` map (`a<spellId>` -> { id, name, icon } | null,
   * the icon carrying its `.jpg`); consumers project it to the id-keyed art
   * `wl-game-icon` expects (see `abilityIcons`). `gameData.ability` resolves any REAL id
   * - including passives a report's `masterData.abilities` omits - but returns `null` for
   * a nonexistent id (which `abilityIcons` skips). Ability ids that come from live events
   * are always real; the only hand-authored ids are the rulebook's, and the ingest
   * integrity gate rejects an unresolvable one before it can reach a card.
   */
  async getAbilities(ids: number[]): Promise<Record<string, WclRawAbility | null>> {
    const unique = [...new Set(ids)].filter(id => id > 0);
    if (!unique.length) return {};
    const result = await this.query<{ gameData: Record<string, WclRawAbility | null> }>(
      buildAbilityIconsQuery(unique),
    );
    return result?.gameData ?? {};
  }

  /**
   * Raw top-DPS rankings envelope for an encounter + spec. `characterRankings` comes
   * back as a JSON blob (string or object); it is returned as-is (`null` for an
   * unknown spec, since no query can be built). Consumers unwrap both forms and map
   * to fetchable `ParseRanking` rows (see `unwrapRankings` / `toParseRankings`).
   */
  async getRankings(spec: string, encounterId: number): Promise<WclRankingsBlob | null> {
    const meta = specMetaOf(spec);
    if (!meta) return null;
    const vars: RankingsQueryVars = { encounterID: encounterId, className: meta.className, specName: meta.specName };
    const result = await this.query<{ worldData: { encounter: { characterRankings: WclRankingsBlob } } }>(
      RANKINGS_Q, vars,
    );
    return result?.worldData?.encounter?.characterRankings ?? null;
  }
}
