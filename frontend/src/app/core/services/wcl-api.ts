import { Injectable, inject } from '@angular/core';
import { WclAuthService } from '../transport/wcl-auth';
import { WCL_TRANSPORT, WclTransportError, WCL_UNUSABLE_STATUS } from './wcl-transport';
import {
  WclReport, WclEvent,
  PlayerDetailGroups, WclRankingsBlob, WclRawAbility, WclCombatantInfo, WclTableBlob,
  WclClass, WclExpansion,
  MYTHIC_DIFFICULTY,
} from '../models/wcl.models';
import {
  REPORT_Q, REPORT_FIGHTS_Q, PLAYER_DETAILS_Q, EVENTS_Q,
  COMBATANT_INFO_Q, RANKINGS_Q, TABLE_Q, RESURRECTS_Q, buildGearNamesQuery, buildAbilityIconsQuery,
  RATE_LIMIT_Q, CLASSES_Q, ENCOUNTERS_Q,
} from './wcl-queries';
import type {
  ClassesQuery,
  CombatantInfoQuery, CombatantInfoQueryVariables,
  EncountersQuery,
  EventDataType, EventsQuery, EventsQueryVariables, HostilityType,
  PlayerDetailsQuery, PlayerDetailsQueryVariables,
  RankingsQuery, RankingsQueryVariables,
  RateLimitQuery,
  ReportFightsQuery, ReportQuery, ReportQueryVariables,
  ResurrectsQuery, ResurrectsQueryVariables,
  TableQuery, TableQueryVariables,
} from './wcl-operations.generated';
import { SpecMetaService } from './spec-meta';

type WclPointsBudget = NonNullable<RateLimitQuery['rateLimitData']>;

// WCL declares every selected field nullable, so these reads narrow the generated envelope once instead of pushing null into every consumer.
@Injectable({ providedIn: 'root' })
export class WclApiService {
  private readonly auth = inject(WclAuthService);
  private readonly transport = inject(WCL_TRANSPORT);
  private readonly specMeta = inject(SpecMetaService);

  // A 401 refreshes the token and retries once, so an early-rejected token (early expiry, rotated secret) recovers in place.
  async query<TData>(gqlString: string, variables: object = {}): Promise<TData> {
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
    const vars: ReportQueryVariables = { code };
    const result = await this.query<ReportQuery>(REPORT_Q, vars);
    const report = result.reportData?.report;
    // WCL returns report: null for a code it won't serve (missing, private, expired) with no GraphQL error.
    if (!report) throw this.reportUnavailable(code);
    return report as WclReport;
  }

  /** Fights-only read of a report - the live-sync poll's new-pull probe. */
  async getReportFights(code: string): Promise<WclReport['fights']> {
    const vars: ReportQueryVariables = { code };
    const result = await this.query<ReportFightsQuery>(REPORT_FIGHTS_Q, vars);
    const report = result.reportData?.report;
    if (!report) throw this.reportUnavailable(code);
    return (report.fights ?? []) as WclReport['fights'];
  }

  /** Raw `playerDetails` groups (dps / healers / tanks / unknown). Consumers map to spec. */
  async getPlayerDetails(code: string, fightId: number): Promise<PlayerDetailGroups> {
    const vars: PlayerDetailsQueryVariables = { code, fightIDs: [fightId] };
    const result = await this.query<PlayerDetailsQuery>(PLAYER_DETAILS_Q, vars);
    const playerDetails = result.reportData?.report?.playerDetails?.data?.playerDetails;
    if (!playerDetails) throw this.reportUnavailable(code);
    return playerDetails;
  }

  /** A report WCL won't serve (missing, private, expired): permanent, since a retry can't help. */
  private reportUnavailable(code: string): WclTransportError {
    return new WclTransportError(
      `WCL report ${code} is unavailable (not found, private, or expired).`, WCL_UNUSABLE_STATUS,
    );
  }

  private async fetchEventPages(
    gqlString: string, code: string, vars: EventsQueryVariables | ResurrectsQueryVariables,
  ): Promise<WclEvent[]> {
    const events: WclEvent[] = [];
    let currentStart = vars.startTime;
    for (;;) {
      const result = await this.query<EventsQuery | ResurrectsQuery>(gqlString, { ...vars, startTime: currentStart });
      const page = result.reportData?.report?.events;
      if (!page) throw this.reportUnavailable(code);
      // Element by element: WCL overshoots the requested limit (22k rows in one page on a 34-minute pull), and spreading that many arguments into push overflows the call stack.
      for (const event of page.data ?? []) events.push(event);
      if (!page.nextPageTimestamp) break;
      currentStart = page.nextPageTimestamp;
    }
    return events;
  }

  async getAllEvents(
    code: string, fightId: number, dataType: EventDataType,
    startTime: number, endTime: number, sourceId?: number,
    includeResources = false, hostilityType?: HostilityType,
  ): Promise<WclEvent[]> {
    const vars: EventsQueryVariables = { code, fightIDs: [fightId], dataType, startTime, endTime };
    if (sourceId != null) vars.sourceID = sourceId;
    if (includeResources) vars.includeResources = true;
    if (hostilityType) vars.hostilityType = hostilityType;
    return this.fetchEventPages(EVENTS_Q, code, vars);
  }

  // Returns the events array as WCL returns it (empty when the log carries none); consumers pick the player's event (see `selectCombatantInfo`).
  async getCombatantInfo(code: string, fightId: number, playerId: number): Promise<WclCombatantInfo[]> {
    const vars: CombatantInfoQueryVariables = { code, fightIDs: [fightId], sourceID: playerId };
    const result = await this.query<CombatantInfoQuery>(COMBATANT_INFO_Q, vars);
    const report = result.reportData?.report;
    if (!report) throw this.reportUnavailable(code);
    return report.events?.data ?? [];
  }

  // Consumers pick their player's `data.entries` row by actor id and derive DPS from `total` over the fight duration.
  async getDamageDoneTable(code: string, fightId: number): Promise<WclTableBlob | null> {
    const vars: TableQueryVariables = { code, fightIDs: [fightId], dataType: 'DamageDone' };
    const result = await this.query<TableQuery>(TABLE_Q, vars);
    return result.reportData?.report?.table ?? null;
  }

  // WCL has no `Resurrects` data type, so this scans `All` with a server-side `type` filter (only matches come back).
  async getResurrects(code: string, fightId: number, startTime: number, endTime: number): Promise<WclEvent[]> {
    const vars: ResurrectsQueryVariables = { code, fightIDs: [fightId], filter: 'type = "resurrect"', startTime, endTime };
    return this.fetchEventPages(RESURRECTS_Q, code, vars);
  }

  // Names may carry HTML entities, so consumers decode them.
  async getGameNames(itemIds: number[], enchantIds: number[]): Promise<Record<string, { id: number; name: string }>> {
    if (!itemIds.length && !enchantIds.length) return {};
    const result = await this.query<{ gameData: Record<string, { id: number; name: string }> | null }>(
      buildGearNamesQuery(itemIds, enchantIds),
    );
    return result.gameData ?? {};
  }

  // `gameData.ability` resolves any REAL id - including passives a report's `masterData.abilities` omits - but returns `null` for a nonexistent id.
  async getAbilities(ids: number[]): Promise<Record<string, WclRawAbility | null>> {
    const unique = [...new Set(ids)].filter(id => id > 0);
    if (!unique.length) return {};
    const result = await this.query<{ gameData: Record<string, WclRawAbility | null> | null }>(
      buildAbilityIconsQuery(unique),
    );
    return result.gameData ?? {};
  }

  // Returned as-is (`null` for an unknown spec, since no query can be built); consumers unwrap both forms (see `unwrapRankings` / `toParseRankings`), and a null `partition` leaves the variable unset, which is what makes WCL fall back to the zone's current one.
  async getRankings(spec: string, encounterId: number, partition: number | null): Promise<WclRankingsBlob | null> {
    const meta = await this.specMeta.resolve(spec);
    if (!meta) return null;
    const vars: RankingsQueryVariables = { encounterID: encounterId, className: meta.className, specName: meta.specName, difficulty: MYTHIC_DIFFICULTY };
    if (partition != null) vars.partition = partition;
    const result = await this.query<RankingsQuery>(RANKINGS_Q, vars);
    return result.worldData?.encounter?.characterRankings ?? null;
  }

  /** null when WCL serves no rate-limit block: the budget is unknown, not exhausted. */
  async getPointsBudget(): Promise<WclPointsBudget | null> {
    const result = await this.query<RateLimitQuery>(RATE_LIMIT_Q);
    return result.rateLimitData;
  }

  async getPlayableClasses(): Promise<WclClass[]> {
    const result = await this.query<ClassesQuery>(CLASSES_Q);
    return (result.gameData?.classes ?? []) as WclClass[];
  }

  /** null when WCL serves no expansion tree: collapsing that to [] would silently read as "no current raid". */
  async getZoneTree(): Promise<WclExpansion[] | null> {
    const result = await this.query<EncountersQuery>(ENCOUNTERS_Q);
    return (result.worldData?.expansions ?? null) as WclExpansion[] | null;
  }
}
