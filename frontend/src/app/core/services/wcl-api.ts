import { Injectable, inject } from '@angular/core';
import { WclAuthService } from './wcl-auth';
import { WCL_TRANSPORT, WclTransportError, WCL_UNUSABLE_STATUS } from './wcl-transport';
import {
  WclReport, WclEvent,
  PlayerDetailGroups, WclRankingsBlob, WclRawAbility, WclCombatantInfo, WclTableBlob,
} from '../models/wcl.models';
import {
  REPORT_Q, REPORT_FIGHTS_Q, PLAYER_DETAILS_Q, EVENTS_Q,
  COMBATANT_INFO_Q, RANKINGS_Q, TABLE_Q, RESURRECTS_Q, buildGearNamesQuery, buildAbilityIconsQuery,
  ReportQueryVars, PlayerDetailsQueryVars,
  EventsQueryVars, CombatantInfoQueryVars, RankingsQueryVars, TableQueryVars, ResurrectsQueryVars,
} from './wcl-queries';
import { specMetaOf } from '../spec-meta';

@Injectable({ providedIn: 'root' })
export class WclApiService {
  private readonly auth = inject(WclAuthService);
  private readonly transport = inject(WCL_TRANSPORT);

  // A 401 refreshes the token and retries once, so an early-rejected token (early expiry, rotated secret) recovers in place.
  async query<TData = unknown>(gqlString: string, variables: object = {}): Promise<TData> {
    const token = await this.auth.getToken();
    try {
      return await this.transport.query<TData>(gqlString, variables, token);
    } catch (error) {
      if (error instanceof WclTransportError && error.status === 401) {
        // A second 401 propagates and classifies as permanent.
        this.auth.invalidate();
        const freshToken = await this.auth.getToken();
        return await this.transport.query<TData>(gqlString, variables, freshToken);
      }
      throw error;
    }
  }

  async getReport(code: string): Promise<WclReport> {
    const vars: ReportQueryVars = { code };
    const result = await this.query<{ reportData: { report: WclReport | null } }>(REPORT_Q, vars);
    const report = result?.reportData?.report;
    // WCL returns report: null for a code it won't serve (missing, private, expired) with no GraphQL error.
    if (!report) throw this.reportUnavailable(code);
    return report;
  }

  /** Fights-only read of a report - the live-sync poll's new-pull probe. */
  async getReportFights(code: string): Promise<WclReport['fights']> {
    const vars: ReportQueryVars = { code };
    const result = await this.query<{ reportData: { report: { fights: WclReport['fights'] } | null } }>(
      REPORT_FIGHTS_Q, vars,
    );
    const report = result?.reportData?.report;
    // Same unserved-report case as getReport; fail typed rather than into a TypeError.
    if (!report) throw this.reportUnavailable(code);
    return report.fights ?? [];
  }

  /** Raw `playerDetails` groups (dps / healers / tanks / unknown). Consumers map to spec. */
  async getPlayerDetails(code: string, fightId: number): Promise<PlayerDetailGroups> {
    const vars: PlayerDetailsQueryVars = { code, fightIDs: [fightId] };
    const result = await this.query<{ reportData: { report: { playerDetails: { data: { playerDetails: PlayerDetailGroups } } } | null } }>(
      PLAYER_DETAILS_Q, vars,
    );
    const playerDetails = result?.reportData?.report?.playerDetails?.data?.playerDetails;
    // Same unserved-report case as getReport; fail typed rather than into a TypeError.
    if (!playerDetails) throw this.reportUnavailable(code);
    return playerDetails;
  }

  /** A report WCL won't serve (missing, private, expired): permanent, since a retry can't help. */
  private reportUnavailable(code: string): WclTransportError {
    return new WclTransportError(
      `WCL report ${code} is unavailable (not found, private, or expired).`, WCL_UNUSABLE_STATUS,
    );
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
      const result = await this.query<{ reportData: { report: { events: { data: WclEvent[]; nextPageTimestamp?: number } } } }>(
        EVENTS_Q, vars,
      );
      const page = result.reportData.report.events;
      // Element by element: WCL overshoots the requested limit (22k rows in one page on a 34-minute pull), and spreading that many arguments into push overflows the call stack.
      for (const event of page.data ?? []) events.push(event);
      if (!page.nextPageTimestamp) break;
      currentStart = page.nextPageTimestamp;
    }
    return events;
  }

  // Returns the events array as WCL returns it (empty when the log carries none); consumers pick the player's event (see `selectCombatantInfo`).
  async getCombatantInfo(code: string, fightId: number, playerId: number): Promise<WclCombatantInfo[]> {
    const vars: CombatantInfoQueryVars = { code, fightIDs: [fightId], sourceID: playerId };
    const result = await this.query<{ reportData: { report: { events: { data: WclCombatantInfo[] } } | null } }>(
      COMBATANT_INFO_Q, vars,
    );
    const report = result?.reportData?.report;
    // Same unserved-report case as getReport; fail typed rather than folding null into a success [].
    if (!report) throw this.reportUnavailable(code);
    return report.events?.data ?? [];
  }

  // Consumers pick their player's `data.entries` row by actor id and derive DPS from `total` over the fight duration.
  async getDamageDoneTable(code: string, fightId: number): Promise<WclTableBlob | null> {
    const vars: TableQueryVars = { code, fightIDs: [fightId], dataType: 'DamageDone' };
    const result = await this.query<{ reportData: { report: { table: WclTableBlob } } }>(
      TABLE_Q, vars,
    );
    return result?.reportData?.report?.table ?? null;
  }

  // WCL has no `Resurrects` data type, so this scans `All` with a server-side `type` filter (only matches come back).
  async getResurrects(code: string, fightId: number, startTime: number, endTime: number): Promise<WclEvent[]> {
    const events: WclEvent[] = [];
    let currentStart = startTime;
    for (;;) {
      const vars: ResurrectsQueryVars = { code, fightIDs: [fightId], filter: 'type = "resurrect"', startTime: currentStart, endTime };
      const result = await this.query<{ reportData: { report: { events: { data: WclEvent[]; nextPageTimestamp?: number } } } }>(
        RESURRECTS_Q, vars,
      );
      const page = result.reportData.report.events;
      for (const event of page.data ?? []) events.push(event);
      if (!page.nextPageTimestamp) break;
      currentStart = page.nextPageTimestamp;
    }
    return events;
  }

  // Names may carry HTML entities, so consumers decode them.
  async getGameNames(itemIds: number[], enchantIds: number[]): Promise<Record<string, { id: number; name: string }>> {
    if (!itemIds.length && !enchantIds.length) return {};
    const result = await this.query<{ gameData: Record<string, { id: number; name: string }> }>(
      buildGearNamesQuery(itemIds, enchantIds),
    );
    return result?.gameData ?? {};
  }

  // `gameData.ability` resolves any REAL id - including passives a report's `masterData.abilities` omits - but returns `null` for a nonexistent id.
  async getAbilities(ids: number[]): Promise<Record<string, WclRawAbility | null>> {
    const unique = [...new Set(ids)].filter(id => id > 0);
    if (!unique.length) return {};
    const result = await this.query<{ gameData: Record<string, WclRawAbility | null> }>(
      buildAbilityIconsQuery(unique),
    );
    return result?.gameData ?? {};
  }

  // Returned as-is (`null` for an unknown spec, since no query can be built); consumers unwrap both forms (see `unwrapRankings` / `toParseRankings`), and an omitted `partition` leaves the variable null, which is what makes WCL fall back to the zone's current one.
  async getRankings(spec: string, encounterId: number, partition?: number | null): Promise<WclRankingsBlob | null> {
    const meta = specMetaOf(spec);
    if (!meta) return null;
    const vars: RankingsQueryVars = { encounterID: encounterId, className: meta.className, specName: meta.specName };
    if (partition != null) vars.partition = partition;
    const result = await this.query<{ worldData: { encounter: { characterRankings: WclRankingsBlob } } }>(
      RANKINGS_Q, vars,
    );
    return result?.worldData?.encounter?.characterRankings ?? null;
  }
}
