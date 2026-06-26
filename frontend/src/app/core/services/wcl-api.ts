import { Injectable, inject } from '@angular/core';
import { WclAuthService } from './wcl-auth';
import { LiveModeState } from './live-mode-state';
import { WCL_TRANSPORT, WCL_INGEST_MODE, WclTransportError } from './wcl-transport';
import {
  WclReport, WclAbility, WclEvent,
  PlayerDetailGroups, WclRawRanking, WclCombatantInfo,
} from '../models/wcl.models';
import {
  REPORT_Q, REPORT_ABILITIES_Q, PLAYER_DETAILS_Q, EVENTS_Q,
  COMBATANT_INFO_Q, RANKINGS_Q, buildGearNamesQuery,
  ReportQueryVars, ReportAbilitiesQueryVars, PlayerDetailsQueryVars,
  EventsQueryVars, CombatantInfoQueryVars, RankingsQueryVars,
} from './wcl-queries';

/** WCL spec folder name -> [WCL className, WCL specName] for the rankings query. */
const SPEC_TO_WCL: Record<string, [string, string]> = {
  RetributionPaladin: ['Paladin', 'Retribution'], HolyPaladin: ['Paladin', 'Holy'], ProtectionPaladin: ['Paladin', 'Protection'],
  FireMage: ['Mage', 'Fire'], ArcaneMage: ['Mage', 'Arcane'], FrostMage: ['Mage', 'Frost'],
  HavocDemonHunter: ['DemonHunter', 'Havoc'], VengeanceDemonHunter: ['DemonHunter', 'Vengeance'],
  FuryWarrior: ['Warrior', 'Fury'], ArmsWarrior: ['Warrior', 'Arms'], ProtectionWarrior: ['Warrior', 'Protection'],
  UnholyDeathKnight: ['DeathKnight', 'Unholy'], FrostDeathKnight: ['DeathKnight', 'Frost'], BloodDeathKnight: ['DeathKnight', 'Blood'],
  BalanceDruid: ['Druid', 'Balance'], FeralDruid: ['Druid', 'Feral'], GuardianDruid: ['Druid', 'Guardian'], RestorationDruid: ['Druid', 'Restoration'],
  BeastMasteryHunter: ['Hunter', 'BeastMastery'], MarksmanshipHunter: ['Hunter', 'Marksmanship'], SurvivalHunter: ['Hunter', 'Survival'],
  BrewmasterMonk: ['Monk', 'Brewmaster'], WindwalkerMonk: ['Monk', 'Windwalker'], MistweaverMonk: ['Monk', 'Mistweaver'],
  DisciplinePriest: ['Priest', 'Discipline'], HolyPriest: ['Priest', 'Holy'], ShadowPriest: ['Priest', 'Shadow'],
  AssassinationRogue: ['Rogue', 'Assassination'], OutlawRogue: ['Rogue', 'Outlaw'], SubtletyRogue: ['Rogue', 'Subtlety'],
  ElementalShaman: ['Shaman', 'Elemental'], EnhancementShaman: ['Shaman', 'Enhancement'], RestorationShaman: ['Shaman', 'Restoration'],
  AfflictionWarlock: ['Warlock', 'Affliction'], DemonologyWarlock: ['Warlock', 'Demonology'], DestructionWarlock: ['Warlock', 'Destruction'],
  DevastationEvoker: ['Evoker', 'Devastation'], PreservationEvoker: ['Evoker', 'Preservation'], AugmentationEvoker: ['Evoker', 'Augmentation'],
};

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

  /** Lightweight fetch of just a report's ability icons, for seeding the icon cache. */
  async getReportAbilities(code: string): Promise<WclAbility[]> {
    const vars: ReportAbilitiesQueryVars = { code };
    const result = await this.query<{ reportData: { report: { masterData: { abilities: WclAbility[] } } } }>(
      REPORT_ABILITIES_Q, vars,
    );
    return result?.reportData?.report?.masterData?.abilities ?? [];
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
   * Raw CombatantInfo event for one player actor in a fight (gear + talentTree).
   * Returns null when the log carries no combatant info for the player. Consumers
   * extract gear / talents and resolve names (see `getGameNames`).
   */
  async getCombatantInfo(code: string, fightId: number, playerId: number): Promise<WclCombatantInfo | null> {
    const vars: CombatantInfoQueryVars = { code, fightIDs: [fightId], sourceID: playerId };
    const result = await this.query<{ reportData: { report: { events: { data: WclCombatantInfo[] } } } }>(
      COMBATANT_INFO_Q, vars,
    );
    const events = result?.reportData?.report?.events?.data ?? [];
    return events.find(event => event.sourceID === playerId) ?? events[0] ?? null;
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
   * Raw top-DPS rankings for an encounter + spec. `characterRankings` comes back as
   * a JSON blob (string or object) - both forms are handled. Returns `[]` for an
   * unknown spec. Consumers map these to fetchable `ParseRanking` rows.
   */
  async getRankings(spec: string, encounterId: number): Promise<WclRawRanking[]> {
    const mapping = SPEC_TO_WCL[spec];
    if (!mapping) return [];
    const [className, specName] = mapping;
    const vars: RankingsQueryVars = { encounterID: encounterId, className, specName };
    const result = await this.query<{ worldData: { encounter: { characterRankings: string | { rankings: WclRawRanking[] } } } }>(
      RANKINGS_Q, vars,
    );
    const raw = result?.worldData?.encounter?.characterRankings;
    if (!raw) return [];
    const parsed = typeof raw === 'string' ? JSON.parse(raw) as { rankings?: WclRawRanking[] } : raw;
    return parsed.rankings ?? [];
  }
}
