import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { WclAuthService } from './wcl-auth';
import { WclReport, CharacterInfo, CharacterGear, WclUserCharacter, WclEvent } from '../models/wcl.models';

interface PlayerDetailEntry { id: number; type: string; name: string; specs?: Array<{ spec: string }>; }
type PlayerDetailGroups = Record<string, PlayerDetailEntry[]>;

interface WclGearItem { id?: number | string; name?: string; permanentEnchant?: number | string; permanentEnchantName?: string; }
interface WclTalentNode { node?: { nodeId?: number }; nodeId?: number; }
interface WclTalentTree { class?: Record<string, WclTalentNode[]>; spec?: Record<string, WclTalentNode[]>; }
interface WclRankEntry {
  startTime?: number;
  spec?: string;
  class?: number;
  report?: { code?: string };
  gear?: WclGearItem[];
  talents?: WclTalentTree;
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

const FIGHTS_Q = `
query($code:String!){reportData{report(code:$code){fights(killType:All){id}}}}`;

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
      throw new Error('Not logged in to WCL - click "Sign In" to authorize.');
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
          throw new Error('WCL session expired - sign in again.');
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
    const d = await this.query<{ reportData: { report: { playerDetails: { data: { playerDetails: PlayerDetailGroups } } } } }>(PD_Q, { code, fightIDs: [fightId] });
    const details = d.reportData.report.playerDetails.data.playerDetails;
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
    return raw.map(c => ({
      id: c.id,
      name: c.name,
      serverSlug: c.server?.slug || '',
      serverRegion: c.server?.region?.slug || '',
    }));
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

    const target = char.name.toLowerCase();
    for (const rep of reports.slice(0, 3)) {
      try {
        const fd = await this.query<{ reportData: { report: { fights: Array<{ id: number }> } } }>(FIGHTS_Q, { code: rep.code });
        const fights = fd.reportData.report.fights || [];
        if (!fights.length) continue;
        const specMap = await this.getPlayerDetails(rep.code, fights[0].id);
        // playerDetails carries both `id -> spec` and `name_${id} -> name`; match by name.
        const nameKey = Object.keys(specMap).find(k => k.startsWith('name_') && specMap[k].toLowerCase() === target);
        const id = nameKey?.slice('name_'.length);
        if (id && specMap[id]) { spec = specMap[id]; sourceReport = rep.code; break; }
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

    const { trinkets, enchants } = this._extractGear(mostRecent);
    const talent_key = this._talentKeyV2(mostRecent.talents);
    const specPart = mostRecent.spec || '';
    const className = CLASS_NAMES[mostRecent.class ?? -1] || '';
    const fullSpec = specPart && className ? specPart + className : specPart;

    const enchantIds = [...new Set(enchants.filter(e => e.id).map(e => e.id))];
    if (enchantIds.length) {
      let gd: Record<string, { id: number; name: string }> = {};
      try {
        const parts = enchantIds.map(id => `e${id}: enchant(id:${id}){id name}`).join(' ');
        const encD = await this.query<{ gameData: Record<string, { id: number; name: string }> }>(`query{gameData{${parts}}}`);
        gd = encD?.gameData || {};
      } catch { /* leave gd empty - any unresolved name surfaces as a visible marker below */ }
      for (const e of enchants) {
        if (!e.name && e.id) e.name = gd[`e${e.id}`]?.name || 'Unknown enchant';
      }
    }

    return { found: true, spec: fullSpec, source_report: mostRecent.report?.code || null, talent_key, trinkets, enchants };
  }

  /** Trinkets (gear slots 12/13) and permanent enchants from a ranking's combatant info. */
  private _extractGear(entry: WclRankEntry): { trinkets: NonNullable<CharacterGear['trinkets']>; enchants: NonNullable<CharacterGear['enchants']> } {
    const trinkets: NonNullable<CharacterGear['trinkets']> = [];
    const enchants: NonNullable<CharacterGear['enchants']> = [];
    (entry.gear || []).forEach((item, idx) => {
      if (item?.id == null) return;
      const id = typeof item.id === 'string' ? parseInt(item.id, 10) : item.id;
      if (idx === 12 || idx === 13) trinkets.push({ slot: idx, id, name: item.name || '' });
      const enc = item.permanentEnchant;
      if (enc) {
        const eid = typeof enc === 'string' ? parseInt(enc, 10) : enc;
        enchants.push({ slot: idx, id: eid, name: item.permanentEnchantName || '' });
      }
    });
    return { trinkets, enchants };
  }

  /** Midnight talent tree (from `encounterRankings`) → sorted `v2:` node-id key. */
  private _talentKeyV2(talents: WclTalentTree | undefined): string {
    if (!talents) return '';
    const ids: number[] = [];
    for (const section of [talents.class, talents.spec]) {
      if (!section) continue;
      for (const rowArr of Object.values(section)) {
        for (const e of (rowArr || [])) {
          const nid = e?.node?.nodeId ?? e?.nodeId;
          if (nid != null) ids.push(nid);
        }
      }
    }
    return ids.length ? 'v2:' + [...new Set(ids)].sort((a, b) => a - b).join(',') : '';
  }
}
