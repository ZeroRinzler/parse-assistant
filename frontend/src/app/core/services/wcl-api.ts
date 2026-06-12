import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { WclAuthService } from './wcl-auth';
import { WclReport, CharacterInfo, CharacterGear, WclUserCharacter, WclEvent } from '../models/wcl.models';

interface PlayerDetailEntry { id: number; type: string; name: string; specs?: Array<{ spec: string }>; }
type PlayerDetailGroups = Record<string, PlayerDetailEntry[]>;

interface WclGearItem { id?: number | string; name?: string; permanentEnchant?: number | string; permanentEnchantName?: string; }
interface WclTalentNode { node?: { nodeId?: number }; nodeId?: number; }
type WclTalentTree = { class?: Record<string, WclTalentNode[]>; spec?: Record<string, WclTalentNode[]> };
type WclTalents = string | Array<{ talentID?: number; id?: number }> | WclTalentTree;
interface WclRankEntry {
  startTime?: number;
  spec?: string;
  class?: number;
  report?: { code?: string };
  gear?: WclGearItem[];
  talents?: WclTalents;
}

const API_URL = 'https://www.warcraftlogs.com/api/v2/user';

const CLASS_NAMES: Record<number, string> = {
  1:'DeathKnight',2:'Druid',3:'Hunter',4:'Mage',5:'Monk',
  6:'Paladin',7:'Priest',8:'Rogue',9:'Shaman',10:'Warlock',
  11:'Warrior',12:'DemonHunter',13:'Evoker',
};

const REPORT_Q = `
query($code:String!){reportData{report(code:$code){
  title
  fights(killType:All){id name startTime endTime kill encounterID difficulty friendlyPlayers}
  masterData{
    actors(type:"Player"){id name subType server}
    abilities{gameID name icon}
  }
}}}`;

const PD_Q = `
query($code:String!,$fightIDs:[Int]!){
  reportData{report(code:$code){playerDetails(fightIDs:$fightIDs)}}
}`;

const EVENTS_Q = `
query($code:String!,$fightIDs:[Int]!,$dataType:EventDataType,$sourceID:Int,$startTime:Float,$endTime:Float){
  reportData{report(code:$code){
    events(fightIDs:$fightIDs,dataType:$dataType,sourceID:$sourceID,
           startTime:$startTime,endTime:$endTime,limit:10000){data nextPageTimestamp}
  }}
}`;

const USER_CHARS_Q = `{userData{currentUser{characters{id name server{slug region{slug}}}}}}`;

const CHAR_Q = `
query($name:String!,$serverSlug:String!,$serverRegion:String!){
  characterData{character(name:$name,serverSlug:$serverSlug,serverRegion:$serverRegion){
    name classID
    recentReports(limit:5){data{code startTime}}
  }}
}`;

const CHAR_ENC_Q = `
query($name:String!,$serverSlug:String!,$serverRegion:String!,$encID:Int!){
  characterData{character(name:$name,serverSlug:$serverSlug,serverRegion:$serverRegion){
    encounterRankings(encounterID:$encID,includeCombatantInfo:true)
  }}
}`;

@Injectable({ providedIn: 'root' })
export class WclApiService {
  private readonly auth = inject(WclAuthService);
  private readonly http = inject(HttpClient);

  async query<T = unknown>(gql: string, variables: Record<string, unknown> = {}): Promise<T> {
    const token = this.auth.getToken();
    if (!token) {
      this.auth.logout();
      throw new Error('Not logged in to WCL — click "Sign In" to authorize.');
    }
    let body: { data?: T; errors?: { message?: string }[] };
    try {
      body = await firstValueFrom(this.http.post<{ data?: T; errors?: { message?: string }[] }>(
        API_URL,
        { query: gql, variables },
        { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } },
      ));
    } catch (e) {
      if (e instanceof HttpErrorResponse) {
        if (e.status === 401) {
          this.auth.logout();
          throw new Error('WCL session expired — sign in again.');
        }
        throw new Error(`WCL API error (${e.status})`);
      }
      throw e;
    }
    if (body.errors?.length) throw new Error(body.errors[0].message || 'WCL GraphQL error');
    return body.data as T;
  }

  async getReport(code: string): Promise<WclReport> {
    const d = await this.query<{ reportData: { report: WclReport } }>(REPORT_Q, { code });
    return d.reportData.report;
  }

  async getPlayerDetails(code: string, fightId: number): Promise<Record<number | string, string>> {
    const d = await this.query<{ reportData: { report: { playerDetails: string | { data?: { playerDetails?: PlayerDetailGroups } } } } }>(PD_Q, { code, fightIDs: [fightId] });
    const raw = d.reportData.report.playerDetails;
    const outer = (typeof raw === 'string' ? JSON.parse(raw) : raw) as { data?: { playerDetails?: PlayerDetailGroups } } & PlayerDetailGroups;
    const details: PlayerDetailGroups = outer?.data?.playerDetails ?? outer ?? {};
    const map: Record<number | string, string> = {};
    for (const role of ['dps', 'healers', 'tanks', 'unknown']) {
      for (const p of (details[role] || [])) {
        const cls = (p.type || '').replace(/ /g, '');
        const spec = ((p.specs || [])[0]?.spec || '').replace(/ /g, '');
        if (spec && cls) map[p.id] = spec + cls;
        if (p.name) map[`name_${p.id}`] = p.name;
      }
    }
    return map;
  }

  async getAllEvents(
    code: string, fightId: number, dataType: string,
    startTime: number, endTime: number, sourceId?: number
  ): Promise<WclEvent[]> {
    const events: WclEvent[] = [];
    let ts = startTime;
    for (;;) {
      const vars: Record<string, unknown> = { code, fightIDs: [fightId], dataType, startTime: ts, endTime };
      if (sourceId != null) vars['sourceID'] = sourceId;
      const d = await this.query<{ reportData: { report: { events: { data: WclEvent[]; nextPageTimestamp?: number } } } }>(EVENTS_Q, vars);
      const page = d.reportData.report.events;
      events.push(...(page.data || []));
      if (!page.nextPageTimestamp) break;
      ts = page.nextPageTimestamp;
    }
    return events;
  }

  async fetchUserCharacters(): Promise<WclUserCharacter[]> {
    const d = await this.query<{ userData: { currentUser: { characters: Array<{ id: number; name: string; server: { slug: string; region: { slug: string } } }> } } }>(USER_CHARS_Q);
    const raw = d?.userData?.currentUser?.characters || [];
    const chars: WclUserCharacter[] = raw.map(c => ({
      id: c.id,
      name: c.name,
      serverSlug: c.server?.slug || '',
      serverRegion: c.server?.region?.slug || '',
    }));
    try { localStorage.setItem('wcl_user_chars', JSON.stringify(chars)); } catch { /* ignore */ }
    return chars;
  }

  getCachedUserChars(): WclUserCharacter[] {
    try { return JSON.parse(localStorage.getItem('wcl_user_chars') || '[]') || []; } catch { return []; }
  }

  async charLookup(name: string, serverSlug: string, serverRegion: string): Promise<CharacterInfo> {
    const d = await this.query<{ characterData: { character: { name: string; classID: number; recentReports: { data: Array<{ code: string }> } } } }>(
      CHAR_Q, { name, serverSlug, serverRegion }
    );
    const char = d?.characterData?.character;
    if (!char) throw new Error(`Character not found: ${name}-${serverSlug} (${serverRegion})`);

    let spec: string | null = null;
    let sourceReport: string | null = null;
    const reports = char.recentReports?.data || [];
    if (!reports.length) throw new Error('No recent WCL reports found for this character.');
    sourceReport = reports[0].code;

    for (const rep of reports.slice(0, 3)) {
      try {
        const rd = await this.getReport(rep.code);
        const fights = rd.fights || [];
        if (!fights.length) continue;
        const specMap = await this.getPlayerDetails(rep.code, fights[0].id);
        const actor = (rd.masterData?.actors || []).find(a => a.name.toLowerCase() === char.name.toLowerCase());
        if (actor && specMap[actor.id]) { spec = specMap[actor.id]; sourceReport = rep.code; break; }
      } catch { /* try next report */ }
    }
    return { name: char.name, spec, server: serverSlug, region: serverRegion, source_report: sourceReport };
  }

  async getCharGear(name: string, server: string, region: string, encounterId: number): Promise<CharacterGear> {
    const d = await this.query<{ characterData: { character: { encounterRankings: string | { ranks?: WclRankEntry[] } } } }>(
      CHAR_ENC_Q, { name, serverSlug: server, serverRegion: region, encID: encounterId }
    );
    const raw = d?.characterData?.character?.encounterRankings;
    if (raw == null) throw new Error(`Character not found: ${name}-${server} (${region})`);
    const rankData = typeof raw === 'string' ? JSON.parse(raw) as { ranks?: WclRankEntry[] } : raw;
    const ranks = rankData?.ranks || [];
    if (!ranks.length) return { found: false, message: 'No ranked kills found for this encounter.' };

    const mostRecent = ranks.reduce((best, r) =>
      (r.startTime || 0) > (best.startTime || 0) ? r : best
    );

    const gear = this._extractCombatantInfo(mostRecent);
    const specPart = mostRecent.spec || '';
    const className = CLASS_NAMES[mostRecent.class ?? -1] || '';
    const fullSpec = specPart && className ? specPart + className : specPart;

    const enchantIds = [...new Set(gear.enchants!.filter(e => e.id).map(e => e.id))];
    if (enchantIds.length) {
      try {
        const parts = enchantIds.map(id => `e${id}: enchant(id:${id}){id name}`).join(' ');
        const encD = await this.query<{ gameData: Record<string, { id: number; name: string }> }>(`query{gameData{${parts}}}`);
        const gd = encD?.gameData || {};
        for (const e of gear.enchants!) {
          if (!e.name && e.id) e.name = gd[`e${e.id}`]?.name || '';
        }
      } catch { /* enchant names are non-critical */ }
    }

    return { found: true, spec: fullSpec, source_report: mostRecent.report?.code || null, ...gear };
  }

  private _extractCombatantInfo(entry: WclRankEntry): Partial<CharacterGear> {
    if (!entry) return { talent_key: '', trinkets: [], enchants: [] };
    const gearArr = entry.gear || [];
    const talentsR = entry.talents;
    const trinkets: CharacterGear['trinkets'] = [];
    const enchants: CharacterGear['enchants'] = [];

    gearArr.forEach((item, idx) => {
      if (item?.id == null) return;
      const id = typeof item.id === 'string' ? parseInt(item.id, 10) : item.id;
      const name = item.name || '';
      if (idx === 12 || idx === 13) trinkets!.push({ slot: idx, id, name });
      const enc = item.permanentEnchant;
      if (enc) {
        const eid = typeof enc === 'string' ? parseInt(enc, 10) : enc;
        enchants!.push({ slot: idx, id: eid, name: item.permanentEnchantName || '' });
      }
    });

    let talentKey = '';
    if (typeof talentsR === 'string' && talentsR) {
      talentKey = talentsR;
    } else if (Array.isArray(talentsR) && talentsR.length) {
      const ids = talentsR.filter(t => t?.talentID || t?.id).map(t => (t.talentID ?? t.id)!);
      if (ids.length) talentKey = 'v1:' + [...ids].sort().join(',');
    } else if (talentsR && typeof talentsR === 'object' && !Array.isArray(talentsR)) {
      const ids: number[] = [];
      for (const section of [talentsR.class, talentsR.spec]) {
        if (!section) continue;
        for (const rowArr of Object.values(section)) {
          if (!Array.isArray(rowArr)) continue;
          for (const e of rowArr) {
            const nid = e?.node?.nodeId ?? e?.nodeId;
            if (nid != null) ids.push(nid);
          }
        }
      }
      if (ids.length) talentKey = 'v2:' + [...new Set(ids)].sort((a, b) => a - b).join(',');
    }

    return { talent_key: talentKey, trinkets, enchants };
  }
}
