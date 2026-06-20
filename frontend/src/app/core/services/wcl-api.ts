import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { WclAuthService } from './wcl-auth';
import { WclReport, WclAbility, CharacterInfo, CharacterGear, WclUserCharacter, WclEvent } from '../models/wcl.models';
import { logWarn } from '../log';
import {
  REPORT_Q, REPORT_ABILITIES_Q, PLAYER_DETAILS_Q, FIGHTS_Q, EVENTS_Q,
  USER_CHARS_Q, CHAR_Q, CHAR_ENC_Q, buildEnchantNamesQuery,
  ReportQueryVars, ReportAbilitiesQueryVars, PlayerDetailsQueryVars,
  FightsQueryVars, EventsQueryVars, CharQueryVars, CharEncQueryVars,
} from './wcl-queries';
import {
  buildSpecMap, mapUserCharacters, extractGear, talentKeyV2,
  CLASS_NAMES, WclRankEntry, PlayerDetailGroups,
} from './wcl-mappers';

const API_URL = 'https://www.warcraftlogs.com/api/v2/user';

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

  async getCharGear(name: string, server: string, region: string, encounterId: number): Promise<CharacterGear> {
    const vars: CharEncQueryVars = { name, serverSlug: server, serverRegion: region, encID: encounterId };
    const result = await this.query<{ characterData: { character: { encounterRankings: string | { ranks?: WclRankEntry[] } } } }>(
      CHAR_ENC_Q, vars,
    );
    const rawRankings = result?.characterData?.character?.encounterRankings;
    if (rawRankings == null) throw new Error(`Character not found: ${name}-${server} (${region})`);
    const rankData = typeof rawRankings === 'string'
      ? JSON.parse(rawRankings) as { ranks?: WclRankEntry[] }
      : rawRankings;
    const ranks = rankData?.ranks ?? [];
    if (!ranks.length) return { found: false, message: 'No ranked kills found for this encounter.' };

    const mostRecent = ranks.reduce((best, rank) =>
      (rank.startTime ?? 0) > (best.startTime ?? 0) ? rank : best,
    );

    const { trinkets, enchants, gem_count } = extractGear(mostRecent);
    const talent_key = talentKeyV2(mostRecent.talents);
    const specPart = mostRecent.spec ?? '';
    const className = CLASS_NAMES[mostRecent.class ?? -1] ?? '';
    const fullSpec = specPart && className ? specPart + className : specPart;

    const enchantIds = [...new Set(enchants.filter(e => e.id).map(e => e.id))];
    if (enchantIds.length) {
      let enchantNames: Record<string, { id: number; name: string }> = {};
      try {
        const enchantData = await this.query<{ gameData: Record<string, { id: number; name: string }> }>(
          buildEnchantNamesQuery(enchantIds),
        );
        enchantNames = enchantData?.gameData ?? {};
      } catch (err) {
        logWarn('getCharGear: enchant name resolution failed', err);
        // Unresolved names surface as a visible 'Unknown enchant' marker below.
      }
      for (const enchant of enchants) {
        if (!enchant.name && enchant.id) enchant.name = enchantNames[`e${enchant.id}`]?.name ?? 'Unknown enchant';
      }
    }

    return { found: true, spec: fullSpec, source_report: mostRecent.report?.code ?? null, talent_key, trinkets, enchants, gem_count };
  }
}
