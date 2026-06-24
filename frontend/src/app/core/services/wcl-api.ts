import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
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

const API_URL = 'https://www.warcraftlogs.com/api/v2/user';

/** A CombatantInfo event carries gear + talentTree, keyed by sourceID. */
interface CombatantInfoEvent {
  sourceID?: number;
  gear?: WclRankEntry['gear'];
  talentTree?: Array<{ nodeID?: number }>;
}

@Injectable({ providedIn: 'root' })
export class WclApiService {
  private readonly auth = inject(WclAuthService);
  private readonly http = inject(HttpClient);

  async query<TData = unknown>(gql: string, variables: object = {}): Promise<TData> {
    const token = this.auth.getToken();
    if (!token) {
      this.auth.logout();
      throw new Error('Not logged in to WCL - click "Sign In" to authorize.');
    }
    let body: { data?: TData; errors?: { message?: string }[] };
    try {
      body = await firstValueFrom(this.http.post<{ data?: TData; errors?: { message?: string }[] }>(
        API_URL,
        { query: gql, variables },
        { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } },
      ));
    } catch (error) {
      if (error instanceof HttpErrorResponse) {
        if (error.status === 401) {
          this.auth.logout();
          throw new Error('WCL session expired - sign in again.');
        }
        throw new Error(`WCL API error (${error.status})`);
      }
      throw error;
    }
    if (body.errors?.length) throw new Error(body.errors[0].message || 'WCL GraphQL error');
    return body.data as TData;
  }

  async getReport(code: string): Promise<WclReport> {
    const vars: ReportQueryVars = { code };
    const result = await this.query<{ reportData: { report: WclReport } }>(REPORT_Q, vars);
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
      const result = await this.query<{ reportData: { report: { events: { data: WclEvent[]; nextPageTimestamp?: number } } } }>(
        EVENTS_Q, vars,
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
