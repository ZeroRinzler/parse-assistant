import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { Apollo, gql } from 'apollo-angular';
import { ServerError, CombinedGraphQLErrors, type FetchPolicy, type OperationVariables } from '@apollo/client';
import { WclAuthService } from './wcl-auth';
import { WclReport, WclAbility, CharacterInfo, CharacterGear, WclUserCharacter, WclEvent } from '../models/wcl.models';
import { logWarn } from '../log';
import {
  REPORT_Q, REPORT_ABILITIES_Q, PLAYER_DETAILS_Q, FIGHTS_Q, EVENTS_Q,
  USER_CHARS_Q, CHAR_Q, COMBATANT_INFO_Q, buildGearNamesQuery,
  ReportQueryVars, ReportAbilitiesQueryVars, PlayerDetailsQueryVars,
  FightsQueryVars, EventsQueryVars, CharQueryVars, CombatantInfoQueryVars,
} from './wcl-queries';
import {
  buildSpecMap, mapUserCharacters, extractGear, talentKeyFromTree, decodeHtmlEntities,
  WclRankEntry, PlayerDetailGroups,
} from './wcl-mappers';

/** A CombatantInfo event carries gear + talentTree, keyed by sourceID. */
interface CombatantInfoEvent {
  sourceID?: number;
  gear?: WclRankEntry['gear'];
  talentTree?: Array<{ nodeID?: number }>;
}

@Injectable({ providedIn: 'root' })
export class WclApiService {
  private readonly auth = inject(WclAuthService);
  private readonly apollo = inject(Apollo);

  /**
   * Runs a GraphQL query against WCL via Apollo. The PKCE bearer token is attached
   * per request through Apollo's operation context (it changes on re-auth, so it must
   * not be baked into the link). `fetchPolicy` defaults to `cache-first` to leverage
   * Apollo's in-memory cache; callers that must always see fresh data (report polling,
   * large event fetches) pass `network-only`.
   */
  async query<TData = unknown>(
    gqlString: string, variables: object = {}, fetchPolicy: FetchPolicy = 'cache-first',
  ): Promise<TData> {
    const token = this.auth.getToken();
    if (!token) {
      this.auth.logout();
      throw new Error('Not logged in to WCL - click "Sign In" to authorize.');
    }
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
        if (error.statusCode === 401) {
          this.auth.logout();
          throw new Error('WCL session expired - sign in again.');
        }
        throw new Error(`WCL API error (${error.statusCode})`);
      }
      // A 200 response carrying a top-level `errors` array surfaces as CombinedGraphQLErrors.
      if (CombinedGraphQLErrors.is(error)) {
        throw new Error(error.errors[0]?.message || 'WCL GraphQL error');
      }
      throw error;
    }
  }

  async getReport(code: string): Promise<WclReport> {
    const vars: ReportQueryVars = { code };
    // network-only: the report is re-polled to detect new pulls, so it must never
    // be served from cache (a cache hit would silently hide newly-recorded fights).
    const result = await this.query<{ reportData: { report: WclReport } }>(REPORT_Q, vars, 'network-only');
    return result.reportData.report;
  }

  /** Lightweight fetch of just a report's ability icons, for seeding the icon cache. */
  async getReportAbilities(code: string): Promise<WclAbility[]> {
    const vars: ReportAbilitiesQueryVars = { code };
    const result = await this.query<{ reportData: { report: { masterData: { abilities: WclAbility[] } } } }>(
      REPORT_ABILITIES_Q, vars,
    );
    return result?.reportData?.report?.masterData?.abilities ?? [];
  }

  async getPlayerDetails(code: string, fightId: number): Promise<Record<number | string, string>> {
    const vars: PlayerDetailsQueryVars = { code, fightIDs: [fightId] };
    const result = await this.query<{ reportData: { report: { playerDetails: { data: { playerDetails: PlayerDetailGroups } } } } }>(
      PLAYER_DETAILS_Q, vars,
    );
    return buildSpecMap(result.reportData.report.playerDetails.data.playerDetails);
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
      // network-only: event pages are large and per-pull; caching them wastes memory
      // and risks serving stale data on re-analysis.
      const result = await this.query<{ reportData: { report: { events: { data: WclEvent[]; nextPageTimestamp?: number } } } }>(
        EVENTS_Q, vars, 'network-only',
      );
      const page = result.reportData.report.events;
      events.push(...(page.data ?? []));
      if (!page.nextPageTimestamp) break;
      currentStart = page.nextPageTimestamp;
    }
    return events;
  }

  /**
   * Fetch the analyzed player's gear, trinkets, enchants, and talent key from the
   * current combat log's CombatantInfo event - not from historical ranked kills.
   * This ensures data is always available (every pull records combatant info)
   * regardless of whether the player has a ranked kill on the encounter.
   */
  async getCombatantGear(code: string, fightId: number, playerId: number, spec?: string): Promise<CharacterGear> {
    const vars: CombatantInfoQueryVars = { code, fightIDs: [fightId], sourceID: playerId };
    const result = await this.query<{ reportData: { report: { events: { data: CombatantInfoEvent[] } } } }>(
      COMBATANT_INFO_Q, vars,
    );
    const events = result?.reportData?.report?.events?.data ?? [];
    const event = events.find(e => e.sourceID === playerId) ?? events[0];

    if (!event?.gear?.length) {
      return { found: false, message: 'No combatant info in this log.' };
    }

    const { trinkets, enchants } = extractGear(event as WclRankEntry);
    const talent_key = talentKeyFromTree(event.talentTree);

    // Resolve item and enchant names in a single batched gameData query.
    const itemIds = [...new Set(trinkets.filter(t => t.id).map(t => t.id))];
    const enchantIds = [...new Set(enchants.filter(e => e.id).map(e => e.id))];
    if (itemIds.length || enchantIds.length) {
      let nameData: Record<string, { id: number; name: string }> = {};
      try {
        const nameResult = await this.query<{ gameData: Record<string, { id: number; name: string }> }>(
          buildGearNamesQuery(itemIds, enchantIds),
        );
        nameData = nameResult?.gameData ?? {};
      } catch (err) {
        logWarn('getCombatantGear: name resolution failed', err);
      }
      for (const trinket of trinkets) {
        if (!trinket.name && trinket.id) {
          trinket.name = decodeHtmlEntities(nameData[`i${trinket.id}`]?.name ?? '');
        }
      }
      for (const enchant of enchants) {
        if (!enchant.name && enchant.id) {
          enchant.name = decodeHtmlEntities(nameData[`e${enchant.id}`]?.name ?? '');
        }
      }
    }

    return { found: true, spec, source_report: code, talent_key, trinkets, enchants };
  }

  async getUserCharacters(): Promise<WclUserCharacter[]> {
    const result = await this.query<{ userData: { currentUser: { characters: Array<{ id: number; name: string; server: { slug: string; region: { slug: string } } }> } } }>(
      USER_CHARS_Q,
    );
    return mapUserCharacters(result?.userData?.currentUser?.characters ?? []);
  }

  async getCharacter(name: string, serverSlug: string, serverRegion: string): Promise<CharacterInfo> {
    const vars: CharQueryVars = { name, serverSlug, serverRegion };
    const result = await this.query<{ characterData: { character: { name: string; classID: number; recentReports: { data: Array<{ code: string }> } } } }>(
      CHAR_Q, vars,
    );
    const character = result?.characterData?.character;
    if (!character) throw new Error(`Character not found: ${name}-${serverSlug} (${serverRegion})`);

    let spec: string | null = null;
    let sourceReport: string | null = null;
    const reports = character.recentReports?.data ?? [];
    if (!reports.length) throw new Error('No recent WCL reports found for this character.');
    sourceReport = reports[0].code;

    const characterNameLower = character.name.toLowerCase();
    for (const report of reports.slice(0, 3)) {
      try {
        const fightsVars: FightsQueryVars = { code: report.code };
        const fightsData = await this.query<{ reportData: { report: { fights: Array<{ id: number }> } } }>(
          FIGHTS_Q, fightsVars,
        );
        const fights = fightsData.reportData.report.fights ?? [];
        if (!fights.length) continue;
        const specMap = await this.getPlayerDetails(report.code, fights[0].id);
        // playerDetails carries both `id -> spec` and `name_${id} -> name`; match by name.
        const nameKey = Object.keys(specMap).find(
          key => key.startsWith('name_') && specMap[key].toLowerCase() === characterNameLower,
        );
        const playerId = nameKey?.slice('name_'.length);
        if (playerId && specMap[playerId]) { spec = specMap[playerId]; sourceReport = report.code; break; }
      } catch (err) {
        logWarn('getCharacter: spec resolution failed for report ' + report.code, err);
      }
    }
    return { name: character.name, spec, server: serverSlug, region: serverRegion, source_report: sourceReport };
  }
}
