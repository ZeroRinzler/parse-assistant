#!/usr/bin/env node
/**
 * warcraft-learner - Standalone Parse Ingestion CLI
 *
 * Fetches top WCL parses for a spec+encounter and writes:
 *   data/specs/{spec}/parse_samples/{enc_id}.json  - raw samples
 *   data/specs/{spec}/encounters/{enc_id}.json      - aggregated bench data
 *   data/specs/{spec}/encounters.json               - encounter index
 *
 * Usage:
 *   npm run ingest
 *
 * Requires: WCL_CLIENT_ID and WCL_CLIENT_SECRET environment variables.
 * Use the GitHub Actions workflow to run this - it reads from repository secrets.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Command } from 'commander';
import { GraphQLClient, ClientError } from 'graphql-request';
import { BLOODLUST_IDS } from '../src/app/core/analysis/format.ts';
import { talentKeyFromTree, type WclGearItem } from '../src/app/core/services/wcl-mappers.ts';
import type { Rulebook, RulebookCooldown, RulebookDefensive } from '../src/app/core/models/rulebook.models.ts';
import type { ParsePositions, EncounterPositions } from '../src/app/core/models/positioning.models.ts';
import type {
  HoldWindow, CdCastSummary, DefensiveCastSummary,
  RawBurstWindowAbility, RawBurstWindow,
  RawDefensiveWindowAbility, RawDefensiveWindow,
  ParseCooldownData, ParseSample,
} from './parse-sample.models.ts';
import * as ss from 'simple-statistics';
import pLimit from 'p-limit';
import { readJson, writeJson, getKnownSpecs as listSpecs, validateRulebook } from './lib.ts';

// ── Paths ─────────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FRONTEND_ROOT = path.resolve(__dirname, '..');
// WL_DATA_DIR lets a test/dry run write elsewhere instead of the committed data dir.
const DATA_DIR = process.env['WL_DATA_DIR'] ?? path.join(FRONTEND_ROOT, 'public', 'data', 'specs');
// Ingest only manages specs that already have a rulebook to drive analysis.
const getKnownSpecs = (): string[] => listSpecs(DATA_DIR, { requireRulebook: true });

// Hash of this script file - used as a cache key so any change to ingestion logic
// automatically invalidates existing parse samples and forces re-analysis.
const INGEST_HASH = crypto.createHash('sha256')
  .update(fs.readFileSync(__filename, 'utf8'))
  .digest('hex')
  .slice(0, 12);

// ── Constants ─────────────────────────────────────────────────────────────────

const WCL_TOKEN_URL = 'https://www.warcraftlogs.com/oauth/token';
const WCL_API_URL = 'https://www.warcraftlogs.com/api/v2/client';
const TOP_N = 10;

// Aggregation thresholds (fractions of the sample/member count). Mirrored in
// CLAUDE.md's "Analysis thresholds" section - keep the two in sync.
const CLUSTER_MIN_FRAC = 0.35;      // min cluster size to surface a burst/defensive window
const HOLD_TRIGGER_FRAC = 0.4;      // min parsers holding at a cast index to emit a hold target
const MEMBER_MAJORITY_FRAC = 0.5;   // "more than half the member parses" (ability inclusion, majority hold)

const SPEC_TO_WCL_FORWARD: Record<string, [string, string]> = {
  RetributionPaladin:    ['Paladin',    'Retribution'],
  HolyPaladin:           ['Paladin',    'Holy'],
  ProtectionPaladin:     ['Paladin',    'Protection'],
  FireMage:              ['Mage',       'Fire'],
  ArcaneMage:            ['Mage',       'Arcane'],
  FrostMage:             ['Mage',       'Frost'],
  HavocDemonHunter:      ['DemonHunter','Havoc'],
  VengeanceDemonHunter:  ['DemonHunter','Vengeance'],
  FuryWarrior:           ['Warrior',    'Fury'],
  ArmsWarrior:           ['Warrior',    'Arms'],
  ProtectionWarrior:     ['Warrior',    'Protection'],
  UnholyDeathKnight:     ['DeathKnight','Unholy'],
  FrostDeathKnight:      ['DeathKnight','Frost'],
  BloodDeathKnight:      ['DeathKnight','Blood'],
  BalanceDruid:          ['Druid',      'Balance'],
  FeralDruid:            ['Druid',      'Feral'],
  GuardianDruid:         ['Druid',      'Guardian'],
  RestorationDruid:      ['Druid',      'Restoration'],
  BeastMasteryHunter:    ['Hunter',     'BeastMastery'],
  MarksmanshipHunter:    ['Hunter',     'Marksmanship'],
  SurvivalHunter:        ['Hunter',     'Survival'],
  BrewmasterMonk:        ['Monk',       'Brewmaster'],
  WindwalkerMonk:        ['Monk',       'Windwalker'],
  MistweaverMonk:        ['Monk',       'Mistweaver'],
  DisciplinePriest:      ['Priest',     'Discipline'],
  HolyPriest:            ['Priest',     'Holy'],
  ShadowPriest:          ['Priest',     'Shadow'],
  AssassinationRogue:    ['Rogue',      'Assassination'],
  OutlawRogue:           ['Rogue',      'Outlaw'],
  SubtletyRogue:         ['Rogue',      'Subtlety'],
  ElementalShaman:       ['Shaman',     'Elemental'],
  EnhancementShaman:     ['Shaman',     'Enhancement'],
  RestorationShaman:     ['Shaman',     'Restoration'],
  AfflictionWarlock:     ['Warlock',    'Affliction'],
  DemonologyWarlock:     ['Warlock',    'Demonology'],
  DestructionWarlock:    ['Warlock',    'Destruction'],
  DevastationEvoker:     ['Evoker',     'Devastation'],
  PreservationEvoker:    ['Evoker',     'Preservation'],
  AugmentationEvoker:    ['Evoker',     'Augmentation'],
};

const SPEC_TO_WCL = SPEC_TO_WCL_FORWARD;

// ── CLI argument parsing ───────────────────────────────────────────────────────

const program = new Command()
  .name('ingest')
  .description('Fetch top WCL parses for all known specs (stalest-first) and write bench data.')
  .option('--spec <spec>', 'target a single spec instead of all (e.g. SubtletyRogue)')
  .addHelpText('after', `\nKnown specs: ${Object.keys(SPEC_TO_WCL_FORWARD).join(', ')}`);

program.parse(process.argv);
const opts = program.opts<{ spec?: string }>();

const EXCLUDE_ZONE_PATTERNS = ['beta', 'ptr', 'mythic+', 'complete raids', 'delves', 'torghast'];

// Skip encounters whose samples were all refreshed within this window.
const FRESH_HOURS = 23;
// Stop cleanly when fewer than this many WCL points remain in the hour.
const POINTS_MARGIN = 500;
// Max parses fetched/analyzed concurrently per encounter. Bounds the burst of
// WCL requests so concurrency cannot blow past the point budget; each task still
// asserts budget before its network work.
const PARSE_CONCURRENCY = 4;

// ── Ingest-local WCL API response types ──────────────────────────────────────

interface WclRateLimitData {
  limitPerHour?: number;
  pointsSpentThisHour?: number;
  pointsResetIn?: number | null;
}

interface WclPartition { id: number; name: string; }
interface WclZone { id: number; name: string; partitions?: WclPartition[]; encounters?: Array<{ id: number; name: string }>; }
interface WclExpansion { id: number; name: string; zones?: WclZone[]; }

interface WclServerRef { id?: number; name?: string; region?: { slug?: string }; }
interface WclReportRef { code?: string; fightID?: number; }

interface WclRawRanking {
  name?: string;
  amount?: number;
  duration?: number;
  server?: WclServerRef;
  report?: WclReportRef;
  gear?: WclGearItem[];
}

interface WclFightEntry { id: number; startTime: number; endTime: number; encounterID: number; }
interface WclActorEntry { id: number; name: string; type: string; subType?: string; gameID?: number | null; }

// Event from WCL (may include position fields when includeResources: true).
interface WclResourceEvent {
  type: string;
  timestamp: number;
  abilityGameID?: number;
  amount?: number;
  absorbed?: number;
  sourceID?: number;
  targetID?: number;
  resourceActor?: number;
  x?: number;
  y?: number;
  facing?: number;
  mapID?: number;
  maxHitPoints?: number;
}

// CombatantInfo event shape.
interface WclCombatantInfoEvent {
  type: string;
  timestamp: number;
  sourceID?: number;
  talentTree?: Array<{ id?: number; rank?: number; nodeID?: number }>;
}

// ── Ingest-local aggregation types ───────────────────────────────────────────

interface ParseRanking {
  rank: number;
  player: string;
  amount: number;
  duration_s: number;
  report_code: string;
  fight_id: number;
  server: string;
  _raw: WclRawRanking;
}

interface EnrichedRanking {
  server_slug: string;
  server_region: string;
  combatant_info: {
    talent_key: string;
    trinkets: Array<{ slot: number; id: number | string; name: string }>;
    enchants: Array<{ slot: number; id: number | string; name: string }>;
  };
}

interface IngestEncounter {
  id: number;
  name: string;
  zone: string;
  expansion: string;
  partitionIds: number[];
}

// Shared base for clustered windows (written to encounters/{enc_id}.json).
interface ClusterBaseStats {
  time_s: number;
  stddev_s: number;
  count: number;
  total_samples: number;
  dmg_avg: number;
  dmg_stddev: number;
  dmg_min: number;
  dmg_max: number;
  ability_breakdown: Array<{
    spell_id: number;
    avg_damage: number;
    min_damage: number;
    max_damage: number;
    count: number;
    avg_casts?: number;
  }>;
  ref_game_id: number | null;
}

interface ClusteredBurstWindow extends ClusterBaseStats {
  common_cds: string[];
  avg_targets: number;
  window_length_s: number;
}

interface ClusteredDefensiveWindow extends ClusterBaseStats {
  defensive_name: string;
  spell_id: number;
  common_defensives: string[];
  common_cds: string[];
  window_length_s: number;
}

// Shared entry shape for buildBaseBenchmark.
interface BenchEntry {
  first_cast_s: number | null;
  cast_times_s: number[];
  fight_duration_s: number;
  hold_windows: HoldWindow[];
  cast_pattern: string;
}

// Position sample before resampling.
interface RawPosSample {
  t: number;
  x: number;
  y: number;
  facing: number | null;
  mapID: number | null;
  maxHp: number;
}

interface EnemyWithSamples {
  actorId: number;
  count: number;
  maxHp: number;
  samples: RawPosSample[];
  meta: WclActorEntry;
}

// ── WCL OAuth2 client ─────────────────────────────────────────────────────────

// Thrown when the WCL hourly point budget is (about to be) exhausted. The ingest
// loop catches this to stop cleanly and commit partial progress; the remaining work
// is picked up on the next run. We do NOT retry: the limit resets on an hourly
// boundary and an hourly task must not stall waiting for it.
class BudgetExceededError extends Error {
  override name = 'BudgetExceededError';
  constructor(msg: string) { super(msg); }
}

class WCLClient {
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
    const res = await fetch(WCL_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OAuth2 token error ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = await res.json() as { access_token: string; expires_in?: number };
    this._token = data.access_token;
    this._tokenExpiry = Date.now() / 1000 + (data.expires_in ?? 3600);
    return this._token;
  }

  async query<T = unknown>(gql: string, variables: Record<string, unknown> = {}): Promise<T> {
    const token = await this._getToken();
    try {
      // graphql-request returns the GraphQL `data` payload directly and throws a
      // ClientError both on a non-2xx HTTP status and on a 200 response that carries
      // a top-level `errors` array, so all error handling lives in the catch below.
      return await this._client.request<T>(gql, variables, { Authorization: `Bearer ${token}` });
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
    const data = await this.query<{ rateLimitData?: WclRateLimitData }>(
      'query { rateLimitData { limitPerHour pointsSpentThisHour pointsResetIn } }',
    );
    const rl = data.rateLimitData ?? {};
    if (rl.limitPerHour != null) this._limitPerHour = rl.limitPerHour;
    if (rl.pointsSpentThisHour != null) this._pointsSpentThisHour = rl.pointsSpentThisHour;
    return { limitPerHour: this._limitPerHour, pointsSpentThisHour: this._pointsSpentThisHour, pointsResetIn: rl.pointsResetIn ?? null };
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

  // Streams WCL event pages via cursor pagination, yielding one page of events at a
  // time. The generator owns only the cursor (`nextPageTimestamp`); accumulation is
  // the caller's concern, so deep pagination never builds a growing array in here.
  async *fetchAllEvents(
    code: string, fightId: number, dataType: string,
    startTime: number, endTime: number,
    options: { sourceId?: number; targetId?: number; includeResources?: boolean; hostilityType?: string } = {},
  ): AsyncGenerator<WclResourceEvent[]> {
    const EVENTS_QUERY = `
      query GetEvents(
        $code: String! $fightIDs: [Int]! $dataType: EventDataType
        $sourceID: Int $targetID: Int $startTime: Float $endTime: Float
        $includeResources: Boolean $hostilityType: HostilityType
      ) {
        reportData { report(code: $code) {
          events(fightIDs: $fightIDs dataType: $dataType sourceID: $sourceID
                 targetID: $targetID startTime: $startTime endTime: $endTime
                 includeResources: $includeResources hostilityType: $hostilityType limit: 10000) {
            data nextPageTimestamp
          }
        }}
      }`;
    let currentStart = startTime;
    while (true) {
      const vars: Record<string, unknown> = { code, fightIDs: [fightId], dataType, startTime: currentStart, endTime };
      if (options.sourceId != null) vars['sourceID'] = options.sourceId;
      if (options.targetId != null) vars['targetID'] = options.targetId;
      if (options.includeResources) vars['includeResources'] = true;
      if (options.hostilityType) vars['hostilityType'] = options.hostilityType;
      const data = await this.query<{
        reportData: { report: { events: { data: WclResourceEvent[]; nextPageTimestamp?: number | null } } }
      }>(EVENTS_QUERY, vars);
      const page = data.reportData.report.events;
      if (page.data?.length) yield page.data;
      if (page.nextPageTimestamp == null) break;
      currentStart = page.nextPageTimestamp;
    }
  }

  // Thin accumulator over fetchAllEvents for callers that want the full event list.
  async getAllEvents(
    code: string, fightId: number, dataType: string,
    startTime: number, endTime: number,
    options: { sourceId?: number; targetId?: number; includeResources?: boolean; hostilityType?: string } = {},
  ): Promise<WclResourceEvent[]> {
    const events: WclResourceEvent[] = [];
    for await (const page of this.fetchAllEvents(code, fightId, dataType, startTime, endTime, options)) {
      events.push(...page);
    }
    return events;
  }

  async resolveServerSlug(serverId: number): Promise<[string, string]> {
    const cached = this._serverSlugCache.get(serverId);
    if (cached) return cached;
    const SERVER_QUERY = `query($id: Int!) { worldData { server(id: $id) { slug region { slug } } } }`;
    try {
      const data = await this.query<{ worldData: { server?: { slug?: string; region?: { slug?: string } } } }>(SERVER_QUERY, { id: serverId });
      const srv = data.worldData.server ?? {};
      const result: [string, string] = [(srv.slug ?? '').toLowerCase(), ((srv.region?.slug) ?? '').toLowerCase()];
      this._serverSlugCache.set(serverId, result);
      return result;
    } catch {
      this._serverSlugCache.set(serverId, ['', '']);
      return ['', ''];
    }
  }
}

// ── GraphQL queries ───────────────────────────────────────────────────────────

const ENCOUNTERS_QUERY = `
query {
  worldData {
    expansions {
      id name
      zones {
        id name
        partitions { id name }
        encounters { id name }
      }
    }
  }
}`;

const RANKINGS_QUERY = `
query($encounterID: Int!, $className: String!, $specName: String!, $partition: Int) {
  worldData {
    encounter(id: $encounterID) {
      name
      characterRankings(className: $className specName: $specName metric: dps includeCombatantInfo: true partition: $partition)
    }
  }
}`;

// ── Encounter fetching ────────────────────────────────────────────────────────

async function getEncounters(wcl: WCLClient): Promise<IngestEncounter[]> {
  const data = await wcl.query<{ worldData: { expansions: WclExpansion[] } }>(ENCOUNTERS_QUERY);
  const expansions = data.worldData.expansions;

  const result: IngestEncounter[] = [];
  const firstExp = expansions[0];
  if (!firstExp) return result;

  for (const zone of (firstExp.zones ?? [])) {
    const lname = zone.name.toLowerCase();
    if (EXCLUDE_ZONE_PATTERNS.some(p => lname.includes(p))) continue;
    // Sort partition IDs descending (highest = newest first) so we try the
    // most recent patch partition first and fall back to older ones when the
    // new partition is empty (e.g. right after a patch drops).
    const partitionIds = (zone.partitions ?? [])
      .map(p => p.id)
      .sort((a, b) => b - a);
    for (const enc of (zone.encounters ?? [])) {
      result.push({ id: enc.id, name: enc.name, zone: zone.name, expansion: firstExp.name, partitionIds });
    }
  }
  return result;
}

// ── Gear extraction ───────────────────────────────────────────────────────────

const TRINKET_INDICES = new Set([12, 13]);

// Trinkets (gear slots 12/13) and permanent enchants. Gear shape is identical
// across both ranking APIs, so this is shared.
function extractGear(rankingEntry: WclRawRanking): {
  trinkets: Array<{ slot: number; id: number | string; name: string }>;
  enchants: Array<{ slot: number; id: number | string; name: string }>;
} {
  const gear = rankingEntry.gear ?? [];
  const trinkets: Array<{ slot: number; id: number | string; name: string }> = [];
  const enchants: Array<{ slot: number; id: number | string; name: string }> = [];
  for (let idx = 0; idx < gear.length; idx++) {
    const item = gear[idx];
    if (!item || !item.id) continue;
    const itemId = typeof item.id === 'number' ? item.id : (parseInt(String(item.id)) || item.id);
    const name = item.name ?? '';

    if (TRINKET_INDICES.has(idx)) {
      trinkets.push({ slot: idx, id: itemId, name });
    }

    const encRaw = item.permanentEnchant;
    if (encRaw) {
      const encId = typeof encRaw === 'number' ? encRaw : (parseInt(String(encRaw)) || encRaw);
      enchants.push({ slot: idx, id: encId, name: item.permanentEnchantName ?? '' });
    }
  }
  return { trinkets, enchants };
}

// ── Rankings fetching ─────────────────────────────────────────────────────────

// Cheap rankings fetch: 1 API query. Returns raw ranking objects with an
// additional `_raw` field so the caller can extract gear later.
// Server slug resolution deferred to enrichRanking(); talent key from analyzeParse().
async function fetchRankingsLite(wcl: WCLClient, spec: string, encounterId: number, count = 10, partitionIds: number[] = []): Promise<ParseRanking[]> {
  const mapping = SPEC_TO_WCL[spec];
  if (!mapping) throw new Error(`Unknown spec: ${spec}`);
  const [className, specName] = mapping;

  // Try partitions newest-first; fall back to null (current) when zone has none.
  const attempts: Array<number | null> = partitionIds.length > 0 ? partitionIds : [null];
  let rawRankings: WclRawRanking[] = [];
  for (const partition of attempts) {
    const vars: Record<string, unknown> = { encounterID: encounterId, className, specName };
    if (partition != null) vars['partition'] = partition;
    const data = await wcl.query<{ worldData: { encounter: { name: string; characterRankings: string | { rankings: WclRawRanking[] } } } }>(RANKINGS_QUERY, vars);
    const enc = data.worldData.encounter;
    const raw = enc.characterRankings;
    const rankingsData = typeof raw === 'string' ? JSON.parse(raw) as { rankings: WclRawRanking[] } : raw;
    // Filter anonymous parses (report: null) before slicing - the full page is
    // already in the response, so this costs zero extra queries and ensures we
    // always get TOP_N public (fetchable) parses rather than wasting a slot on
    // a parse we can never access.
    rawRankings = (rankingsData.rankings ?? []).filter(r => r.report?.code).slice(0, count);
    if (rawRankings.length > 0) break;
  }

  return rawRankings.map((r, i) => ({
    rank: i + 1,
    player: r.name ?? '',
    amount: Math.round(r.amount ?? 0),
    duration_s: Math.round((r.duration ?? 0) / 100) / 10,
    report_code: r.report?.code ?? '',
    fight_id: r.report?.fightID ?? 0,
    server: r.server?.name ?? '',
    _raw: r, // kept for enrichRanking(); not persisted
  }));
}

// Per-player enrichment: resolves server slug (1 query, in-memory cached per server).
async function enrichRanking(wcl: WCLClient, ranking: ParseRanking): Promise<EnrichedRanking> {
  const r = ranking._raw;
  const sid = r.server?.id;
  const [serverSlug, serverRegion] = sid ? await wcl.resolveServerSlug(sid) : ['', ''];
  return {
    server_slug: serverSlug,
    server_region: serverRegion,
    combatant_info: { talent_key: '', ...extractGear(r) },
  };
}

// ── Burst window analysis ─────────────────────────────────────────────────────

function findBurstWindows(
  damageEvents: WclResourceEvent[], fightStartMs: number,
  cdSummary: CdCastSummary[], specCds: RulebookCooldown[],
  minPctThreshold = 0.03, castEvents: WclResourceEvent[] = [],
): RawBurstWindow[] {
  const hits = damageEvents
    .filter(e => e.type === 'damage' && (e.amount ?? 0) + (e.absorbed ?? 0) > 0)
    .map(e => [e.timestamp, (e.amount ?? 0) + (e.absorbed ?? 0), e.targetID ?? 0, e.abilityGameID ?? 0] as [number, number, number, number])
    .sort((a, b) => a[0] - b[0]);

  // Cast timestamps per ability - used to count player casts inside each window.
  const casts = castEvents
    .filter(e => e.type === 'cast' && e.abilityGameID)
    .map(e => [e.timestamp, e.abilityGameID!] as [number, number]);

  if (!hits.length) return [];
  const total = hits.reduce((s, h) => s + h[1], 0);
  if (!total) return [];

  // Build windows from CD cast times x CD durations
  const rawWins: Array<{ startS: number; endS: number; cdNames: string[] }> = [];
  for (const cdEntry of cdSummary) {
    const cdDef = specCds.find(c => c.name === cdEntry.name);
    const dur = cdDef?.duration ?? 0;
    if (dur <= 0) continue;
    for (const castS of (cdEntry.cast_times_s ?? [])) {
      rawWins.push({ startS: castS, endS: castS + dur, cdNames: [cdEntry.name] });
    }
  }
  if (!rawWins.length) return [];

  // Merge overlapping or near-adjacent windows (<= 3s gap)
  rawWins.sort((a, b) => a.startS - b.startS);
  const merged: Array<{ startS: number; endS: number; cdNames: string[] }> = [{ ...rawWins[0], cdNames: [...rawWins[0].cdNames] }];
  for (let i = 1; i < rawWins.length; i++) {
    const prev = merged[merged.length - 1];
    const cur = rawWins[i];
    if (cur.startS <= prev.endS + 3) {
      prev.endS = Math.max(prev.endS, cur.endS);
      for (const n of cur.cdNames) { if (!prev.cdNames.includes(n)) prev.cdNames.push(n); }
    } else {
      merged.push({ ...cur, cdNames: [...cur.cdNames] });
    }
  }

  const result: RawBurstWindow[] = [];
  for (const win of merged) {
    const startMs = fightStartMs + win.startS * 1000;
    const endMs = fightStartMs + win.endS * 1000;
    const windowHits = hits.filter(h => h[0] >= startMs && h[0] <= endMs);
    const windowDmg = windowHits.reduce((s, h) => s + h[1], 0);
    if (!windowDmg || windowDmg / total < minPctThreshold) continue;

    const abilityDmg = new Map<number, number>();
    for (const [, dmg, , aid] of windowHits) {
      if (aid) abilityDmg.set(aid, (abilityDmg.get(aid) ?? 0) + dmg);
    }
    // Count casts per ability inside the window (boundary matches damage hits: [start, end]).
    const abilityCasts = new Map<number, number>();
    for (const [ts, aid] of casts) {
      if (ts >= startMs && ts <= endMs) abilityCasts.set(aid, (abilityCasts.get(aid) ?? 0) + 1);
    }
    const topAbilities: RawBurstWindowAbility[] = [...abilityDmg.entries()]
      .sort((a, b) => b[1] - a[1]).slice(0, 6)
      .map(([sid, d]) => ({ spell_id: sid, damage: d, pct: Math.round(d / windowDmg * 1000) / 1000, casts: abilityCasts.get(sid) ?? 0 }));

    result.push({
      time_s: Math.round(win.startS * 10) / 10,
      window_length_s: Math.round((win.endS - win.startS) * 10) / 10,
      pct_of_total: Math.round(windowDmg / total * 1000) / 1000,
      window_damage: windowDmg,
      total_damage: total,
      ability_breakdown: topAbilities,
      active_cds: win.cdNames,
      target_count: 1,
    });
  }
  return result.sort((a, b) => a.time_s - b.time_s);
}

function findDefensiveWindows(
  damageTakenEvents: WclResourceEvent[], fightStartMs: number,
  buffWindows: Map<number, Array<[number, number | null]>>,
  specDefensives: RulebookDefensive[],
  npcById: Map<number, WclActorEntry>,
): RawDefensiveWindow[] {
  const hits = damageTakenEvents
    .filter(e => e.type === 'damage' && (e.amount ?? 0) + (e.absorbed ?? 0) > 0)
    .map(e => [e.timestamp, (e.amount ?? 0) + (e.absorbed ?? 0), e.abilityGameID ?? 0, e.sourceID ?? null] as [number, number, number, number | null])
    .sort((a, b) => a[0] - b[0]);

  if (!hits.length) return [];
  const total = hits.reduce((s, h) => s + h[1], 0);
  if (!total) return [];

  const result: RawDefensiveWindow[] = [];

  for (const defn of specDefensives) {
    const sid = defn.spell_id;
    const dur = defn.duration ?? 5;

    for (const bw of (buffWindows.get(sid) ?? [])) {
      // buffWindows store relative-seconds from fight start
      const startS = bw[0];
      const endS = bw[1] != null ? bw[1] : startS + dur;
      const startMs = fightStartMs + startS * 1000;
      const endMs = fightStartMs + endS * 1000;

      const windowHits = hits.filter(h => h[0] >= startMs && h[0] <= endMs);
      const windowDmg = windowHits.reduce((s, h) => s + h[1], 0);
      const pct = total ? Math.round(windowDmg / total * 1000) / 1000 : 0;

      const abilityDmg = new Map<number, number>();
      for (const [, dmg, aid] of windowHits) {
        if (aid) abilityDmg.set(aid, (abilityDmg.get(aid) ?? 0) + dmg);
      }
      const topAbilities: RawDefensiveWindowAbility[] = [...abilityDmg.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([abilityId, d]) => ({
          spell_id: abilityId,
          damage: d,
          pct: windowDmg ? Math.round(d / windowDmg * 1000) / 1000 : 0,
        }));

      // Reference for the map = the enemy that dealt the most damage in the window.
      const dmgBySource = new Map<number, number>();
      for (const [, dmg, , src] of windowHits) {
        if (src != null && npcById.has(src)) dmgBySource.set(src, (dmgBySource.get(src) ?? 0) + dmg);
      }
      const topSource = [...dmgBySource.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      const refGameId = topSource != null ? (npcById.get(topSource)?.gameID ?? null) : null;

      result.push({
        time_s: Math.round(startS * 10) / 10,
        window_length_s: Math.round((endS - startS) * 10) / 10,
        pct_of_total: pct,
        window_damage: windowDmg,
        total_damage: total,
        ability_breakdown: topAbilities,
        active_cds: [defn.name],
        defensive_name: defn.name,
        spell_id: sid,
        ref_game_id: refGameId ?? null,
      });
    }
  }

  return result.sort((a, b) => a.time_s - b.time_s);
}

// Defensive windows cluster per-defensive first (so Cloak at 1:00 and Feint at 1:00
// remain separate clusters), then by time within each defensive group.
function clusterDefensiveWindows(windows: RawDefensiveWindow[], totalSamples: number, mergeS = 20.0): ClusteredDefensiveWindow[] {
  if (!windows.length) return [];
  const byDefensive = new Map<string, RawDefensiveWindow[]>();
  for (const w of windows) {
    const name = w.defensive_name || w.active_cds?.[0] || '';
    if (!byDefensive.has(name)) byDefensive.set(name, []);
    byDefensive.get(name)!.push(w);
  }
  const result: ClusteredDefensiveWindow[] = [];
  for (const [defensiveName, defWindows] of byDefensive.entries()) {
    for (const cl of groupByTime(defWindows, mergeS)) {
      if (cl.length < Math.max(2, totalSamples * CLUSTER_MIN_FRAC)) continue;
      const base = clusterBaseStats(cl, totalSamples);
      result.push({
        ...base,
        window_length_s: round(mean(cl.map(c => c.window_length_s))),
        defensive_name: defensiveName,
        spell_id: cl[0].spell_id,
        common_defensives: [defensiveName],
        common_cds: [defensiveName],
      });
    }
  }
  return result.sort((a, b) => a.time_s - b.time_s);
}

// ── Parse analysis ────────────────────────────────────────────────────────────

async function loadRulebook(spec: string): Promise<Rulebook | null> {
  const rbPath = path.join(DATA_DIR, spec, 'rulebook.json');
  return readJson<Rulebook>(rbPath);
}

async function getSpecCooldowns(spec: string): Promise<RulebookCooldown[] | null> {
  const rb = await loadRulebook(spec);
  if (rb?.major_cooldowns?.length) return rb.major_cooldowns;
  return null;
}

async function getSpecDefensives(spec: string): Promise<RulebookDefensive[]> {
  const rb = await loadRulebook(spec);
  if (rb?.defensives?.length) return rb.defensives;
  return [];
}

// ── Position timelines ───────────────────────────────────────────────────────
// Positions come from events fetched with includeResources:true, which flattens
// one actor's snapshot onto the event (top-level x/y/facing/mapID); resourceActor
// says whose (1 = source, 2 = target). x/y are hundredths of a yard, facing
// milliradians - stored raw here and scaled by the frontend (positioning-core).

const POSITIONS_INTERVAL_S = 1.5;
const MAX_TRACKED_ENEMIES = 5;
const MIN_ENEMY_SAMPLES = 4;

function posActorId(e: WclResourceEvent): number | null {
  if (typeof e.x !== 'number' || typeof e.y !== 'number') return null;
  return e.resourceActor === 2 ? (e.targetID ?? null) : (e.sourceID ?? null);
}

/** Boss actor id = the NPC with the highest maxHitPoints across resource snapshots. */
function pickBossActorId(events: WclResourceEvent[], npcById: Map<number, WclActorEntry>): number | null {
  const maxHp = new Map<number, number>();
  for (const e of events) {
    const id = posActorId(e);
    if (id == null || !npcById.has(id)) continue;
    const hp = typeof e.maxHitPoints === 'number' ? e.maxHitPoints : 0;
    if (hp > (maxHp.get(id) ?? -1)) maxHp.set(id, hp);
  }
  let bossId: number | null = null, best = -1;
  for (const [id, hp] of maxHp) if (hp > best) { best = hp; bossId = id; }
  return bossId;
}

/** Group raw position samples per actor id from resource-bearing events. */
function collectPositionSamples(events: WclResourceEvent[], fightStartMs: number): Map<number, RawPosSample[]> {
  const byActor = new Map<number, RawPosSample[]>();
  for (const e of events) {
    const id = posActorId(e);
    if (id == null) continue;
    let arr = byActor.get(id);
    if (!arr) { arr = []; byActor.set(id, arr); }
    arr.push({
      t: (e.timestamp - fightStartMs) / 1000,
      x: e.x!, y: e.y!,
      facing: typeof e.facing === 'number' ? e.facing : null,
      mapID: typeof e.mapID === 'number' ? e.mapID : null,
      maxHp: typeof e.maxHitPoints === 'number' ? e.maxHitPoints : 0,
    });
  }
  for (const arr of byActor.values()) arr.sort((a, b) => a.t - b.t);
  return byActor;
}

/** Resample to a fixed cadence: [t, x, y, facing, mapID] rows, linear for x/y, nearest for facing/mapID. */
function resampleTimeline(samples: RawPosSample[], durationS: number, intervalS: number): ParsePositions['player'] {
  if (!samples.length) return [];
  const first = samples[0].t, last = samples[samples.length - 1].t;
  const out: ParsePositions['player'] = [];
  let idx = 0;
  for (let t = 0; t <= durationS + 1e-6; t += intervalS) {
    if (t < first - intervalS || t > last + intervalS) continue;
    while (idx + 1 < samples.length && samples[idx + 1].t <= t) idx++;
    const a = samples[idx];
    const b = samples[idx + 1];
    let x = a.x, y = a.y, near = a;
    if (b && b.t > a.t && t >= a.t) {
      const f = Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t)));
      x = a.x + (b.x - a.x) * f;
      y = a.y + (b.y - a.y) * f;
      near = f < 0.5 ? a : b;
    }
    out.push([
      Math.round(t * 10) / 10, Math.round(x), Math.round(y),
      near.facing == null ? null : Math.round(near.facing), near.mapID,
    ]);
  }
  return out;
}

/**
 * Build the per-parse position payload: the ranked player's timeline plus the
 * notable enemy timelines (boss = highest maxHitPoints). Enemies are keyed by
 * gameID so the frontend can match "the same boss/add" across parses.
 */
function buildParsePositions(
  reportCode: string, fightId: number, playerName: string, playerId: number,
  npcById: Map<number, WclActorEntry>, posEvents: WclResourceEvent[],
  fightStartMs: number, durationS: number,
): ParsePositions {
  const byActor = collectPositionSamples(posEvents, fightStartMs);
  const playerSamples = byActor.get(playerId) ?? [];

  const enemies: EnemyWithSamples[] = [];
  for (const [id, samples] of byActor) {
    if (id === playerId || !npcById.has(id)) continue;
    const maxHp = samples.reduce((m, s) => Math.max(m, s.maxHp), 0);
    enemies.push({ actorId: id, count: samples.length, maxHp, samples, meta: npcById.get(id)! });
  }
  enemies.sort((a, b) => b.count - a.count);
  const bossEntry = enemies.reduce<EnemyWithSamples | null>((best, e) => (e.maxHp > (best?.maxHp ?? -1) ? e : best), null);
  const bossId = bossEntry?.actorId ?? null;
  // Keep the boss plus the most-active enemies (likely add/mechanic casters).
  const kept = enemies.slice(0, MAX_TRACKED_ENEMIES);
  if (bossId != null && !kept.some(e => e.actorId === bossId)) {
    const boss = enemies.find(e => e.actorId === bossId);
    if (boss) kept.push(boss);
  }

  return {
    report_code: reportCode,
    fight_id: fightId,
    player_name: playerName,
    duration_s: Math.round(durationS * 10) / 10,
    interval_s: POSITIONS_INTERVAL_S,
    player: resampleTimeline(playerSamples, durationS, POSITIONS_INTERVAL_S),
    enemies: kept.map(e => ({
      game_id: e.meta.gameID ?? null,
      name: e.meta.name ?? '',
      is_boss: e.actorId === bossId,
      samples: resampleTimeline(e.samples, durationS, POSITIONS_INTERVAL_S),
    })).filter(e => e.is_boss || e.samples.length >= MIN_ENEMY_SAMPLES),
  };
}

async function analyzeParse(
  wcl: WCLClient, spec: string, reportCode: string, fightId: number,
  playerName: string, combatantInfo: EnrichedRanking['combatant_info'],
): Promise<{ cooldown_data: ParseCooldownData; positions: ParsePositions | null } | null> {
  const specCds = await getSpecCooldowns(spec) ?? [];
  const specDefensives = await getSpecDefensives(spec);

  let meta: { reportData: { report: { fights: WclFightEntry[]; masterData: { actors: WclActorEntry[] } } } };
  try {
    const REPORT_META_Q = `
      query($code: String!) {
        reportData { report(code: $code) {
          fights(killType: Kills) { id startTime endTime encounterID }
          masterData { actors { id name type subType gameID } }
        }}
      }`;
    meta = await wcl.query(REPORT_META_Q, { code: reportCode });
  } catch {
    return null;
  }

  const report = meta.reportData.report;
  const fight = report.fights.find(f => f.id === fightId);
  if (!fight) return null;

  const actors = report.masterData.actors;
  const player = actors.find(a => a.name === playerName && a.type === 'Player');
  if (!player) throw new Error(`Player "${playerName}" not found in report ${reportCode} (fight ${fightId}).`);
  // Enemy actor lookup (by actor id) for position timelines, keyed later by gameID.
  const npcById = new Map<number, WclActorEntry>(actors.filter(a => a.type !== 'Player').map(a => [a.id, a]));

  const start = fight.startTime;
  const end = fight.endTime;
  const fightDurS = (end - start) / 1000;

  // Fetch all event types in parallel. Positions ride along on the (smaller)
  // Casts streams via includeResources, keeping the dense damage streams plain.
  let castEvents: WclResourceEvent[], buffEvents: WclResourceEvent[], damageEvents: WclResourceEvent[],
    damageTakenEvents: WclResourceEvent[], enemyCastEvents: WclResourceEvent[], combatantEvents: WclCombatantInfoEvent[];
  try {
    const results = await Promise.all([
      wcl.getAllEvents(reportCode, fightId, 'Casts',         start, end, { sourceId: player.id, includeResources: true }),
      wcl.getAllEvents(reportCode, fightId, 'Buffs',         start, end, { targetId: player.id }),
      wcl.getAllEvents(reportCode, fightId, 'DamageDone',    start, end, { sourceId: player.id }),
      wcl.getAllEvents(reportCode, fightId, 'DamageTaken',   start, end, { sourceId: player.id }),
      wcl.getAllEvents(reportCode, fightId, 'Casts',         start, end, { includeResources: true, hostilityType: 'Enemies' }).catch((): WclResourceEvent[] => []),
      wcl.getAllEvents(reportCode, fightId, 'CombatantInfo', start, end, { sourceId: player.id }).catch((): WclResourceEvent[] => []),
    ]);
    castEvents = results[0];
    buffEvents = results[1];
    damageEvents = results[2];
    damageTakenEvents = results[3];
    enemyCastEvents = results[4];
    combatantEvents = results[5] as unknown as WclCombatantInfoEvent[];
  } catch {
    return null;
  }

  // Dense boss positions from a single targeted stream (boss auto-attacks),
  // identified as the highest-maxHitPoints enemy in the enemy cast snapshots.
  let bossDamageEvents: WclResourceEvent[] = [];
  const bossActorId = pickBossActorId(enemyCastEvents, npcById);
  if (bossActorId != null) {
    bossDamageEvents = await wcl
      .getAllEvents(reportCode, fightId, 'DamageDone', start, end, { sourceId: bossActorId, includeResources: true })
      .catch((): WclResourceEvent[] => []);
  }

  // Detect Bloodlust
  let blTimeS: number | null = null;
  for (const e of buffEvents) {
    if (e.type === 'applybuff' && e.abilityGameID != null && BLOODLUST_IDS.has(e.abilityGameID)) {
      blTimeS = (e.timestamp - start) / 1000;
      break;
    }
  }

  // Per-CD analysis
  const cdSummary: CdCastSummary[] = [];
  for (const cd of specCds) {
    const cdCasts = castEvents
      .filter(c => c.type === 'cast' && c.abilityGameID === cd.spell_id)
      .sort((a, b) => a.timestamp - b.timestamp);

    const castTimesS = cdCasts.map(c => (c.timestamp - start) / 1000);
    const firstCastS = castTimesS.length > 0 ? castTimesS[0] : null;

    let blAligned = false;
    let blOffsetS: number | null = null;
    if (blTimeS != null && castTimesS.length > 0) {
      for (const t of castTimesS) {
        if (blTimeS - 30 <= t && t <= blTimeS + 55) { blAligned = true; break; }
      }
      const windowOffsets = castTimesS
        .filter(t => blTimeS! - 30 <= t && t <= blTimeS! + 55)
        .map(t => t - blTimeS!);
      if (windowOffsets.length > 0) {
        blOffsetS = Math.round(windowOffsets.reduce((best, v) => Math.abs(v) < Math.abs(best) ? v : best) * 10) / 10;
      }
    }

    // Hold pattern
    const holdWindows: HoldWindow[] = [];
    if (castTimesS.length > 1) {
      const cdSeconds = cd.cooldown ?? 90;
      let expectedT = castTimesS[0];
      for (let k = 1; k < castTimesS.length; k++) {
        expectedT += cdSeconds;
        const actual = castTimesS[k];
        const holdAmount = actual - expectedT;
        if (holdAmount > 8.0) {
          holdWindows.push({
            cast_index: k + 1,
            expected_s: Math.round(expectedT * 10) / 10,
            actual_s: Math.round(actual * 10) / 10,
            hold_amount_s: Math.round(holdAmount * 10) / 10,
          });
        }
      }
    }

    cdSummary.push({
      name: cd.name,
      spell_id: cd.spell_id,
      total_uses: cdCasts.length,
      first_cast_s: firstCastS != null ? Math.round(firstCastS * 10) / 10 : null,
      bl_aligned: blAligned,
      bl_offset_s: blOffsetS,
      cast_times_s: castTimesS.map(t => Math.round(t * 100) / 100),
      hold_windows: holdWindows,
      cast_pattern: holdWindows.length > 0 ? 'hold' : 'on_cooldown',
    });
  }

  // Cast efficiency
  const completed = castEvents.filter(e => e.type === 'cast').sort((a, b) => a.timestamp - b.timestamp);
  let castEffPct: number | null = null;
  let castGapListMs: number[] = [];
  if (completed.length >= 2 && fightDurS > 0) {
    castGapListMs = [];
    for (let i = 1; i < completed.length; i++) {
      castGapListMs.push(Math.round(completed[i].timestamp - completed[i - 1].timestamp));
    }
    castGapListMs.sort((a, b) => a - b);
    const downtimeMs = castGapListMs.filter(g => g > 1500).reduce((s, g) => s + g, 0);
    castEffPct = Math.round(Math.max(0, (1 - downtimeMs / 1000 / fightDurS) * 100) * 10) / 10;
  }

  // Burst windows - sized by CD durations, active_cds set inside
  const burstWindows = findBurstWindows(damageEvents, start, cdSummary, specCds, 0.03, castEvents);

  // Gear data from combatant info (trinkets/enchants from rankings; talent key from this fight's
  // CombatantInfo talentTree, which uses the same full-tree representation as the frontend).
  const gearData = combatantInfo;
  const ciEvent = combatantEvents.find(e => e.sourceID === player.id) ?? combatantEvents[0];
  const talentKey = talentKeyFromTree(ciEvent?.talentTree);

  // Defensive tracking
  // Build buff window lookup: Map<spell_id, [[start_s, end_s|null], ...]>
  const buffWindows = new Map<number, Array<[number, number | null]>>();
  for (const e of buffEvents) {
    const sid = e.abilityGameID;
    if (sid == null) continue;
    const tS = (e.timestamp - start) / 1000;
    if (e.type === 'applybuff') {
      if (!buffWindows.has(sid)) buffWindows.set(sid, []);
      buffWindows.get(sid)!.push([tS, null]);
    } else if (e.type === 'removebuff') {
      const windows = buffWindows.get(sid) ?? [];
      for (let i = windows.length - 1; i >= 0; i--) {
        if (windows[i][1] == null) { windows[i][1] = tS; break; }
      }
    }
  }

  const defensiveSummary: DefensiveCastSummary[] = [];
  for (const defn of specDefensives) {
    const sid = defn.spell_id;
    const duration = defn.duration ?? 0;
    const cooldownS = defn.cooldown ?? 90;
    const windows: Array<{ start_s: number; end_s: number; dmg_during: number }> = [];
    let castTimes: number[] = [];

    for (const bw of (buffWindows.get(sid) ?? [])) {
      const wStart = bw[0];
      const wEnd = bw[1] != null ? bw[1] : (duration ? wStart + duration : wStart + 5);
      const dmgDuring = damageTakenEvents
        .filter(e => e.type === 'damage')
        .reduce((s, e) => {
          const tS = (e.timestamp - start) / 1000;
          return tS >= wStart && tS <= wEnd ? s + (e.amount ?? 0) + (e.absorbed ?? 0) : s;
        }, 0);
      windows.push({ start_s: Math.round(wStart * 10) / 10, end_s: Math.round(wEnd * 10) / 10, dmg_during: Math.round(dmgDuring) });
      castTimes.push(Math.round(wStart * 10) / 10);
    }

    // Also track explicit casts for defensives without self-buff
    if (castTimes.length === 0) {
      const casts = castEvents
        .filter(c => c.type === 'cast' && c.abilityGameID === sid)
        .map(c => Math.round((c.timestamp - start) / 1000 * 10) / 10);
      for (const tS of casts) {
        const wEnd = tS + (duration || 5);
        const dmgDuring = damageTakenEvents
          .filter(e => e.type === 'damage')
          .reduce((s, e) => {
            const eS = (e.timestamp - start) / 1000;
            return eS >= tS && eS <= wEnd ? s + (e.amount ?? 0) + (e.absorbed ?? 0) : s;
          }, 0);
        windows.push({ start_s: tS, end_s: Math.round(wEnd * 10) / 10, dmg_during: Math.round(dmgDuring) });
        castTimes.push(tS);
      }
    }

    castTimes.sort((a, b) => a - b);
    const holdWindowsDef: HoldWindow[] = [];
    for (let j = 1; j < castTimes.length; j++) {
      const expectedS = castTimes[j - 1] + cooldownS;
      const actualS = castTimes[j];
      const holdAmountS = actualS - expectedS;
      if (holdAmountS > 8) {
        holdWindowsDef.push({
          cast_index: j,
          expected_s: Math.round(expectedS * 10) / 10,
          actual_s: Math.round(actualS * 10) / 10,
          hold_amount_s: Math.round(holdAmountS * 10) / 10,
        });
      }
    }

    if (castTimes.length > 0) {
      defensiveSummary.push({
        name: defn.name,
        spell_id: sid,
        cooldown: cooldownS,
        uses: castTimes.length,
        cast_times_s: castTimes,
        first_cast_s: castTimes[0],
        hold_windows: holdWindowsDef,
        cast_pattern: holdWindowsDef.length > 0 ? 'hold' : 'on_cooldown',
        windows,
      });
    }
  }

  const defensiveWindows = findDefensiveWindows(damageTakenEvents, start, buffWindows, specDefensives, npcById);

  const cooldownData: ParseCooldownData = {
    player: player.name,
    spec,
    fight_duration_s: Math.round(fightDurS * 10) / 10,
    bloodlust_s: blTimeS != null ? Math.round(blTimeS * 10) / 10 : null,
    cast_efficiency_pct: castEffPct,
    cast_gap_list_ms: castGapListMs,
    cooldowns: cdSummary,
    burst_windows: burstWindows,
    defensives: defensiveSummary,
    defensive_windows: defensiveWindows,
    talent_key: talentKey,
    trinkets: gearData.trinkets,
    enchants: gearData.enchants,
  };

  let positions: ParsePositions | null = null;
  try {
    positions = buildParsePositions(
      reportCode, fightId, player.name, player.id, npcById,
      [...castEvents, ...enemyCastEvents, ...bossDamageEvents], start, fightDurS,
    );
    if (!positions.player.length) positions = null;
  } catch { positions = null; }

  return { cooldown_data: cooldownData, positions };
}

// ── Analysis utils ────────────────────────────────────────────────────────────

// Thin guarded delegators to simple-statistics. The guards preserve the
// zero-on-empty / zero-on-single contract the ~30 call sites rely on
// (ss.mean/ss.median throw on empty input; sampleStandardDeviation needs n >= 2).
// stdev uses the sample (n-1) standard deviation, matching the prior implementation.
function median(arr: number[]): number {
  return arr.length ? ss.median(arr) : 0;
}

function mean(arr: number[]): number {
  return arr.length ? ss.mean(arr) : 0;
}

function stdev(arr: number[]): number {
  return arr.length >= 2 ? ss.sampleStandardDeviation(arr) : 0;
}

function round(v: number, decimals = 1): number {
  return Math.round(v * 10 ** decimals) / 10 ** decimals;
}

// ── Shared clustering primitives ─────────────────────────────────────────────

// Median of an already-ascending-sorted array (O(1)); matches median() exactly.
function medianOfSorted(sortedTimes: number[]): number {
  const mid = sortedTimes.length >> 1;
  return sortedTimes.length % 2
    ? sortedTimes[mid]
    : (sortedTimes[mid - 1] + sortedTimes[mid]) / 2;
}

// Group windows by proximity in time (within mergeS seconds of the running cluster
// median). Single O(N) pass: windows are processed in ascending time order, so the
// moment a new cluster is created every earlier cluster's median is already below
// w - mergeS and (since later windows only increase) can never match again. Hence
// only the most-recently-created cluster is ever a candidate - the previous greedy
// scan over all clusters was redundant. Output is identical to that greedy version.
function groupByTime<T extends { time_s: number }>(windows: T[], mergeS: number): T[][] {
  const sorted = [...windows].sort((a, b) => a.time_s - b.time_s);
  const clusters: T[][] = [];
  let openTimes: number[] = []; // ascending times of the last (only open) cluster
  for (const w of sorted) {
    if (clusters.length && Math.abs(w.time_s - medianOfSorted(openTimes)) <= mergeS) {
      clusters[clusters.length - 1].push(w);
      openTimes.push(w.time_s); // w.time_s >= every prior time, so still sorted
    } else {
      clusters.push([w]);
      openTimes = [w.time_s];
    }
  }
  return clusters;
}

// Common statistics for a cluster of windows (time, absolute damage, ability breakdown).
// Windows are compared by absolute damage rather than share-of-fight-total: on
// progression (wipes) the fight-total denominator is unstable, so a share would
// inflate against full-kill top parses. Absolute damage stays comparable.
function clusterBaseStats(cl: Array<{ time_s: number; window_damage?: number; ability_breakdown?: Array<{ spell_id: number; damage?: number; casts?: number }>; ref_game_id?: number | null }>, totalSamples: number): ClusterBaseStats {
  const times = cl.map(c => c.time_s);
  const dmgs  = cl.map(c => c.window_damage ?? 0);
  const sorted = [...dmgs].sort((a, b) => a - b);

  const abilityTotals = new Map<number, number[]>();
  const abilityCasts = new Map<number, number[]>();
  for (const c of cl) {
    for (const ab of (c.ability_breakdown ?? [])) {
      if (!abilityTotals.has(ab.spell_id)) abilityTotals.set(ab.spell_id, []);
      abilityTotals.get(ab.spell_id)!.push(ab.damage ?? 0);
      // Cast counts only exist on burst windows; defensive windows omit them.
      if (ab.casts != null) {
        if (!abilityCasts.has(ab.spell_id)) abilityCasts.set(ab.spell_id, []);
        abilityCasts.get(ab.spell_id)!.push(ab.casts);
      }
    }
  }
  const ability_breakdown: ClusterBaseStats['ability_breakdown'] = [...abilityTotals.entries()]
    .filter(([, ds]) => ds.length >= cl.length * MEMBER_MAJORITY_FRAC)
    .map(([sid, ds]) => {
      const castsArr = abilityCasts.get(sid);
      const entry: ClusterBaseStats['ability_breakdown'][number] = {
        spell_id: sid,
        avg_damage: Math.round(mean(ds)),
        min_damage: Math.round(Math.min(...ds)),
        max_damage: Math.round(Math.max(...ds)),
        count: ds.length,
      };
      if (castsArr?.length) entry.avg_casts = Math.round(mean(castsArr));
      return entry;
    })
    .sort((a, b) => b.avg_damage - a.avg_damage)
    .slice(0, 6);

  // Majority map-reference enemy across members (defensive windows only; null for burst).
  const refCounts = new Map<number, number>();
  for (const c of cl) if (c.ref_game_id != null) refCounts.set(c.ref_game_id, (refCounts.get(c.ref_game_id) ?? 0) + 1);
  const ref_game_id = [...refCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  return {
    time_s: round(median(times)),
    stddev_s: round(stdev(times)),
    count: cl.length,
    total_samples: totalSamples,
    dmg_avg: Math.round(mean(dmgs)),
    dmg_stddev: Math.round(stdev(dmgs)),
    dmg_min: Math.round(sorted[0]),
    dmg_max: Math.round(sorted[sorted.length - 1]),
    ability_breakdown,
    ref_game_id,
  };
}

function clusterBurstWindows(windows: RawBurstWindow[], totalSamples: number, mergeS = 15.0): ClusteredBurstWindow[] {
  if (!windows.length) return [];
  const result: ClusteredBurstWindow[] = [];
  for (const cl of groupByTime(windows, mergeS)) {
    if (cl.length < Math.max(2, totalSamples * CLUSTER_MIN_FRAC)) continue;
    const base = clusterBaseStats(cl, totalSamples);
    const cdCounts = new Map<string, number>();
    for (const c of cl) {
      for (const name of (c.active_cds ?? [])) cdCounts.set(name, (cdCounts.get(name) ?? 0) + 1);
    }
    const common_cds = [...cdCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .filter(([, cnt]) => cnt >= cl.length * MEMBER_MAJORITY_FRAC)
      .map(([name]) => name);
    const window_length_s = round(mean(cl.map(c => c.window_length_s)));
    result.push({ ...base, common_cds, avg_targets: round(mean(cl.map(c => c.target_count ?? 1))), window_length_s });
  }
  return result.sort((a, b) => a.time_s - b.time_s);
}

interface GearStats {
  sample_count: number;
  talent_builds: Array<{ key: string; count: number; pct: number; report_code?: string; fight_id?: number; player_name?: string }>;
  trinkets: Record<string, Array<{ id: number | string; name: string; count: number; pct: number }>>;
  enchants: Record<string, Array<{ id: number | string; name: string; count: number; pct: number }>>;
}

function aggregateGear(samples: ParseSample[]): GearStats {
  const total = samples.length;
  const talentCounter = new Map<string, number>();
  const talentExample = new Map<string, { report_code: string; fight_id: number; player_name: string }>();
  const trinketCounters: Record<number, Map<number | string, number>> = { 12: new Map(), 13: new Map() };
  const trinketNames = new Map<number | string, string>();
  const enchantCounters = new Map<number, Map<number | string, number>>();
  const enchantNames = new Map<number | string, string>();

  for (const s of samples) {
    const cdData = s.cooldown_data;
    const tk = cdData.talent_key ?? '';
    if (tk) {
      talentCounter.set(tk, (talentCounter.get(tk) ?? 0) + 1);
      if (!talentExample.has(tk)) {
        talentExample.set(tk, {
          report_code: s.report_code ?? '',
          fight_id: s.fight_id,
          player_name: s.player_name ?? '',
        });
      }
    }

    for (const t of (cdData.trinkets ?? [])) {
      const slot = t.slot as 12 | 13;
      const itemId = t.id;
      if ((slot === 12 || slot === 13) && itemId) {
        trinketCounters[slot].set(itemId, (trinketCounters[slot].get(itemId) ?? 0) + 1);
        if (!trinketNames.has(itemId)) trinketNames.set(itemId, t.name ?? '');
      }
    }

    for (const e of (cdData.enchants ?? [])) {
      const slot = e.slot;
      const encId = e.id;
      if (slot != null && encId) {
        if (!enchantCounters.has(slot)) enchantCounters.set(slot, new Map());
        const slotMap = enchantCounters.get(slot)!;
        slotMap.set(encId, (slotMap.get(encId) ?? 0) + 1);
        if (!enchantNames.has(encId)) enchantNames.set(encId, e.name ?? '');
      }
    }
  }

  const talentBuilds = [...talentCounter.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([k, c]) => ({
      key: k, count: c, pct: total ? Math.round(c / total * 100) : 0,
      ...(talentExample.get(k) ?? {}),
    }));

  const trinkets: Record<string, Array<{ id: number | string; name: string; count: number; pct: number }>> = {};
  for (const [slot, counter] of Object.entries(trinketCounters)) {
    const counterMap = counter as Map<number | string, number>;
    if (!counterMap.size) continue;
    trinkets[slot] = [...counterMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([id, c]) => ({ id, name: trinketNames.get(id) ?? '', count: c, pct: total ? Math.round(c / total * 100) : 0 }));
  }

  const enchants: Record<string, Array<{ id: number | string; name: string; count: number; pct: number }>> = {};
  for (const [slot, counter] of enchantCounters.entries()) {
    if (!counter.size) continue;
    enchants[String(slot)] = [...counter.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([id, c]) => ({ id, name: enchantNames.get(id) ?? '', count: c, pct: total ? Math.round(c / total * 100) : 0 }));
  }

  return { sample_count: total, talent_builds: talentBuilds, trinkets, enchants };
}

// ── Enchant name resolution ───────────────────────────────────────────────────

// Patches missing enchant names in an already-written encounter bench file by
// batch-querying WCL `gameData.enchant(id)` for each unique ID whose name is
// empty. Uses GraphQL field aliases so all IDs are resolved in one round-trip.
// Silently skips if the API does not support the query or returns no names.
async function resolveEnchantNames(wcl: WCLClient, spec: string, encounterId: number): Promise<void> {
  const encPath = getEncounterPath(spec, encounterId);
  type EncFile = { gear: { enchants: Record<string, Array<{ id: number | string; name: string }>> } };
  const data = await readJson<EncFile>(encPath);
  if (!data?.gear?.enchants) return;

  const enchantsMap = data.gear.enchants;
  const toResolve = new Map<number | string, Array<{ slot: string; idx: number }>>();
  for (const [slot, items] of Object.entries(enchantsMap)) {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.id && !item.name) {
        if (!toResolve.has(item.id)) toResolve.set(item.id, []);
        toResolve.get(item.id)!.push({ slot, idx: i });
      }
    }
  }
  if (!toResolve.size) return;

  const aliases = [...toResolve.keys()]
    .map(id => `e${id}: enchant(id: ${id}) { id name }`)
    .join('\n    ');
  const query = `query { gameData { ${aliases} } }`;

  try {
    const result = await wcl.query<{ gameData: Record<string, { id: number; name: string } | null | undefined> }>(query);
    const gameData = result.gameData ?? {};
    let patched = false;
    for (const [id, locations] of toResolve.entries()) {
      const name = (gameData[`e${id}`]?.name ?? '').trim();
      if (!name) continue;
      for (const { slot, idx } of locations) {
        enchantsMap[slot][idx].name = name;
        patched = true;
      }
    }
    if (patched) await writeJson(encPath, data);
  } catch {
    // gameData.enchant may not be available for all enchant IDs; keep empty names.
  }
}

// ── File I/O ──────────────────────────────────────────────────────────────────

function nowUtc(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function getSamplesPath(spec: string, encounterId: number): string {
  return path.join(DATA_DIR, spec, 'parse_samples', `${encounterId}.json`);
}

function parseKey(reportCode: string, fightId: number, hash = INGEST_HASH): string {
  return `${reportCode}:${fightId}:${hash}`;
}

function getEncounterPath(spec: string, encounterId: number): string {
  return path.join(DATA_DIR, spec, 'encounters', `${encounterId}.json`);
}

function getPositionsPath(spec: string, encounterId: number): string {
  return path.join(DATA_DIR, spec, 'positions', `${encounterId}.json`);
}

/** Append a parse's position timelines (deduped by report+fight) to the positions file. */
async function savePositions(spec: string, encounterId: number, encounterName: string, positions: ParsePositions | null): Promise<void> {
  if (!positions) return;
  const file = getPositionsPath(spec, encounterId);
  const existing = await readJson<EncounterPositions>(file) ?? {};
  let parses = Array.isArray((existing as EncounterPositions).parses) ? (existing as EncounterPositions).parses : [];
  parses = parses.filter(p => !(p.report_code === positions.report_code && p.fight_id === positions.fight_id));
  parses.push(positions);
  await writeJson(file, {
    spec, encounter_id: encounterId, encounter_name: encounterName,
    interval_s: POSITIONS_INTERVAL_S, sample_count: parses.length, parses,
  }, true);
}

async function saveParseSample(spec: string, encounterId: number, encounterName: string, reportCode: string, fightId: number, playerName: string, cooldownData: ParseCooldownData): Promise<void> {
  const samplesPath = getSamplesPath(spec, encounterId);
  let samples = await readJson<ParseSample[]>(samplesPath) ?? [];
  // Remove duplicate
  samples = samples.filter(s => !(s.report_code === reportCode && s.fight_id === fightId));
  samples.push({
    spec, encounter_id: encounterId, encounter_name: encounterName,
    report_code: reportCode, fight_id: fightId, player_name: playerName,
    sampled_at: nowUtc(), ingest_hash: INGEST_HASH, cooldown_data: cooldownData,
  });
  await writeJson(samplesPath, samples);
}

function benchUsesPerMin(entries: BenchEntry[]): { avg: number; stddev: number; min: number; max: number } | Record<string, never> {
  const upms: number[] = [];
  for (const e of entries) {
    const dur = e.fight_duration_s ?? 0;
    const times = e.cast_times_s ?? [];
    if (dur > 0 && times.length > 0) {
      upms.push(Math.round(times.length / dur * 60 * 1000) / 1000);
    }
  }
  if (!upms.length) return {};
  return {
    avg: round(mean(upms), 3),
    stddev: round(stdev(upms), 3),
    min: Math.min(...upms),
    max: Math.max(...upms),
  };
}

// Per-cast-index hold targets: cast positions where enough top parsers delayed
// the cast, with the median delay players should match. Shared by the cooldown
// and defensive benchmark passes.
function buildHoldTargets(entries: BenchEntry[]): Record<string, { target_s: number; stddev_s: number; count: number; total_samples: number }> {
  const holdByCastIdx = new Map<number, number[]>();
  for (const entry of entries) {
    for (const hw of (entry.hold_windows ?? [])) {
      if (!holdByCastIdx.has(hw.cast_index)) holdByCastIdx.set(hw.cast_index, []);
      holdByCastIdx.get(hw.cast_index)!.push(hw.actual_s);
    }
  }
  const holdTargets: Record<string, { target_s: number; stddev_s: number; count: number; total_samples: number }> = {};
  for (const [castIdx, times] of holdByCastIdx.entries()) {
    if (times.length >= Math.max(2, entries.length * HOLD_TRIGGER_FRAC)) {
      holdTargets[String(castIdx)] = {
        target_s: round(median(times)),
        stddev_s: round(stdev(times)),
        count: times.length,
        total_samples: entries.length,
      };
    }
  }
  return holdTargets;
}

interface BaseBenchmark {
  sample_count: number;
  avg_first_cast_s: number;
  stddev_first_cast_s: number;
  avg_gap_s: number | null;
  stddev_gap_s: number | null;
  hold_targets: Record<string, { target_s: number; stddev_s: number; count: number; total_samples: number }>;
  avg_uses: number;
  avg_uses_per_min: number;
  uses_per_min: { avg: number; stddev: number; min: number; max: number } | Record<string, never>;
  majority_hold: boolean;
}

// Benchmark fields common to cooldowns and defensives. `usesOf` reads the per-parse
// use count (cooldowns expose `total_uses`, defensives `uses`); `requireUsesForUpm`
// excludes zero-use parses from the uses-per-minute mean (defensive behavior).
function buildBaseBenchmark(entries: BenchEntry[], usesOf: (e: BenchEntry) => number, requireUsesForUpm: boolean): BaseBenchmark {
  const topFirstCasts = entries.map(e => e.first_cast_s).filter((v): v is number => v != null);
  const gaps: number[] = [];
  for (const entry of entries) {
    const times = entry.cast_times_s ?? [];
    for (let j = 1; j < times.length; j++) gaps.push(times[j] - times[j - 1]);
  }
  const upmList = entries
    .filter(e => e.fight_duration_s && (!requireUsesForUpm || usesOf(e)))
    .map(e => usesOf(e) / (e.fight_duration_s / 60));
  return {
    sample_count: entries.length,
    avg_first_cast_s: topFirstCasts.length ? round(mean(topFirstCasts)) : 0,
    stddev_first_cast_s: topFirstCasts.length ? round(stdev(topFirstCasts)) : 0,
    avg_gap_s: gaps.length ? round(mean(gaps)) : null,
    stddev_gap_s: gaps.length ? round(stdev(gaps)) : null,
    hold_targets: buildHoldTargets(entries),
    avg_uses: entries.length ? round(mean(entries.map(e => usesOf(e) ?? 0))) : 0,
    avg_uses_per_min: upmList.length ? round(mean(upmList), 2) : 0,
    uses_per_min: benchUsesPerMin(entries),
    majority_hold: entries.filter(e => e.cast_pattern === 'hold').length > entries.length * MEMBER_MAJORITY_FRAC,
  };
}

async function syncEncounterFile(spec: string, encounterId: number): Promise<void> {
  const samplesPath = getSamplesPath(spec, encounterId);
  const samples = await readJson<ParseSample[]>(samplesPath) ?? [];
  if (!samples.length) return;

  const encName = samples[0].encounter_name ?? '';

  // Efficiency
  const allGapsMs: number[] = [];
  for (const s of samples) {
    const gaps = s.cooldown_data.cast_gap_list_ms ?? [];
    allGapsMs.push(...gaps);
  }
  allGapsMs.sort((a, b) => a - b);
  let downtimeThresholdMs = 1500;
  if (allGapsMs.length) {
    const p90Idx = Math.max(0, Math.floor(0.90 * allGapsMs.length) - 1);
    downtimeThresholdMs = allGapsMs[p90Idx];
  }

  const effVals: number[] = [];
  for (const s of samples) {
    const cdData = s.cooldown_data;
    const gapList = cdData.cast_gap_list_ms ?? [];
    const durS = cdData.fight_duration_s ?? 0;
    if (gapList.length && durS > 0) {
      const dtS = gapList.filter(g => g > downtimeThresholdMs).reduce((acc, g) => acc + g, 0) / 1000;
      effVals.push(round(Math.max(0, (1 - dtS / durS) * 100)));
    }
  }
  if (!effVals.length) {
    for (const s of samples) {
      const v = s.cooldown_data.cast_efficiency_pct;
      if (v != null) effVals.push(v);
    }
  }
  const topAvgEfficiency = effVals.length ? round(mean(effVals)) : 0;
  const topEfficiencyStddev = effVals.length ? round(stdev(effVals)) : 0;

  // Per-CD benchmarks
  const agg = new Map<string, Array<CdCastSummary & { fight_duration_s: number }>>();
  for (const s of samples) {
    const cdData = s.cooldown_data;
    const fightDur = cdData.fight_duration_s ?? 0;
    for (const cd of (cdData.cooldowns ?? [])) {
      if (!agg.has(cd.name)) agg.set(cd.name, []);
      agg.get(cd.name)!.push({ ...cd, fight_duration_s: fightDur });
    }
  }

  const perCdBenchmarks: Record<string, BaseBenchmark & { avg_bl_offset_s: number | null; stddev_bl_offset_s: number | null; bl_pct: number }> = {};
  for (const [cdName, entries] of agg.entries()) {
    const blOffsets = entries.map(e => e.bl_offset_s).filter((v): v is number => v != null);
    const blCount = entries.filter(e => e.bl_aligned).length;

    perCdBenchmarks[cdName] = {
      ...buildBaseBenchmark(entries, e => (e as unknown as CdCastSummary).total_uses, false),
      avg_bl_offset_s: blOffsets.length ? round(mean(blOffsets)) : null,
      stddev_bl_offset_s: blOffsets.length ? round(stdev(blOffsets)) : null,
      bl_pct: entries.length ? Math.round(blCount / entries.length * 100) : 0,
    };
  }

  // Duration
  const durations = samples.map(s => s.cooldown_data.fight_duration_s).filter(Boolean) as number[];
  const avgDurationS = durations.length ? round(mean(durations)) : 0;

  // Burst windows
  const allBw: RawBurstWindow[] = [];
  for (const s of samples) {
    for (const bw of (s.cooldown_data.burst_windows ?? [])) allBw.push(bw);
  }
  const burstWindowsClustered = allBw.length ? clusterBurstWindows(allBw, samples.length) : [];

  // Gear
  const gear = aggregateGear(samples);

  // Defensive benchmarks
  const specDefensives = await getSpecDefensives(spec);
  const aggDefUses = new Map<string, number[]>();
  for (const s of samples) {
    for (const d of (s.cooldown_data.defensives ?? [])) {
      if (!aggDefUses.has(d.name)) aggDefUses.set(d.name, []);
      aggDefUses.get(d.name)!.push(d.uses ?? 0);
    }
  }

  const topDefensivesSummary: Array<{ name: string; spell_id: number; avg_uses: number; min_uses: number; max_uses: number; sample_count: number }> = [];
  for (const defn of specDefensives) {
    const uses = aggDefUses.get(defn.name);
    if (!uses?.length) continue;
    topDefensivesSummary.push({
      name: defn.name,
      spell_id: defn.spell_id,
      avg_uses: round(mean(uses)),
      min_uses: Math.min(...uses),
      max_uses: Math.max(...uses),
      sample_count: uses.length,
    });
  }

  const aggDef = new Map<string, Array<DefensiveCastSummary & { fight_duration_s: number }>>();
  for (const s of samples) {
    const cdData = s.cooldown_data;
    const fightDur = cdData.fight_duration_s ?? 0;
    for (const d of (cdData.defensives ?? [])) {
      if (!aggDef.has(d.name)) aggDef.set(d.name, []);
      aggDef.get(d.name)!.push({ ...d, fight_duration_s: fightDur });
    }
  }

  const perDefensiveBenchmarks: Record<string, BaseBenchmark> = {};
  for (const [defName, entries] of aggDef.entries()) {
    perDefensiveBenchmarks[defName] = buildBaseBenchmark(entries, e => (e as DefensiveCastSummary).uses, true);
  }

  // Defensive windows
  const allDw: RawDefensiveWindow[] = [];
  for (const s of samples) {
    for (const dw of (s.cooldown_data.defensive_windows ?? [])) allDw.push(dw);
  }
  const defensiveWindowsClustered = allDw.length ? clusterDefensiveWindows(allDw, samples.length) : [];

  const out = {
    spec, encounter_id: encounterId, encounter_name: encName,
    sample_count: samples.length,
    avg_duration_s: avgDurationS,
    downtime_threshold_ms: Math.round(downtimeThresholdMs),
    top_avg_efficiency: topAvgEfficiency,
    top_efficiency_stddev: topEfficiencyStddev,
    per_cd_benchmarks: perCdBenchmarks,
    burst_windows: burstWindowsClustered,
    gear,
    top_defensives_summary: topDefensivesSummary,
    per_defensive_benchmarks: perDefensiveBenchmarks,
    defensive_windows: defensiveWindowsClustered,
  };

  const encPath = getEncounterPath(spec, encounterId);
  await writeJson(encPath, out);
  await syncEncountersIndex(spec);
}

async function syncEncountersIndex(spec: string): Promise<void> {
  const encDir = path.join(DATA_DIR, spec, 'encounters');
  if (!fs.existsSync(encDir)) return;
  const entries: Array<{ id: number; name: string; sample_count: number }> = [];
  for (const f of fs.readdirSync(encDir).sort()) {
    if (!f.endsWith('.json')) continue;
    try {
      const d = await readJson<{ encounter_id?: number; encounter_name?: string; sample_count?: number }>(path.join(encDir, f)) ?? {};
      entries.push({
        id: d.encounter_id ?? parseInt(f),
        name: d.encounter_name ?? f,
        sample_count: d.sample_count ?? 0,
      });
    } catch {}
  }
  await writeJson(path.join(DATA_DIR, spec, 'encounters.json'), entries);
}

/** Rebuild data/specs/index.json by scanning all spec folders on disk. */
async function writeSpecIndex(): Promise<void> {
  if (!fs.existsSync(DATA_DIR)) return;
  const entries: Array<{ spec: string; encounter_count: number }> = [];
  for (const spec of fs.readdirSync(DATA_DIR).sort()) {
    const encFile = path.join(DATA_DIR, spec, 'encounters.json');
    if (!fs.existsSync(encFile)) continue;
    try {
      const enc = await readJson<Array<{ sample_count?: number }>>(encFile) ?? [];
      const count = enc.filter(e => e.sample_count && e.sample_count > 0).length;
      if (count > 0) entries.push({ spec, encounter_count: count });
    } catch {}
  }
  await writeJson(path.join(DATA_DIR, 'index.json'), entries);
}

// ── Spec selection ────────────────────────────────────────────────────────────

// Returns known specs (those with a rulebook.json) sorted most-stale-first.
async function specsByStaleness(encounters: IngestEncounter[]): Promise<string[]> {
  const now = Date.now();
  const known = getKnownSpecs();
  // Precompute staleness per spec (async I/O) before the synchronous sort.
  const scores = new Map<string, number>(
    await Promise.all(known.map(async spec => [spec, await staleness(spec, encounters, now)] as const)),
  );
  return known.slice().sort((a, b) => (scores.get(a) ?? 0) - (scores.get(b) ?? 0));
}

async function staleness(spec: string, encounters: IngestEncounter[], now: number): Promise<number> {
  let worst = 0;
  for (const enc of encounters) {
    const samples = await readJson<ParseSample[]>(getSamplesPath(spec, enc.id)) ?? [];
    if (!samples.length) return Infinity; // never ingested
    const newestMs = Math.max(...samples.map(s => new Date(s.sampled_at ?? 0).getTime()));
    const ageMs = now - newestMs;
    if (ageMs > worst) worst = ageMs;
  }
  return worst;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function ingestSpecNonInteractive(wcl: WCLClient, spec: string, encounters: IngestEncounter[]): Promise<boolean> {
  console.log(`\nIngesting ${spec} - ${encounters.length} encounters (top ${TOP_N})`);

  // Pre-flight: the rulebook drives every finding (cooldown spell IDs, durations).
  // Refuse to ingest a spec whose rulebook violates the schema rather than emit
  // garbage bench data; log the property-level errors so it can be fixed.
  const rulebook = await loadRulebook(spec);
  const schemaErrors = await validateRulebook(rulebook);
  if (schemaErrors.length) {
    console.error(`\n[${spec}] rulebook.json failed schema validation (${schemaErrors.length} error(s)) - skipping ingestion:`);
    schemaErrors.forEach(err => console.error(`  - ${err}`));
    return false;
  }

  try {
    for (const enc of encounters) {
      // Freshness short-circuit: skip this encounter entirely (0 queries) when we
      // have at least one current-hash sample collected within freshHours. Gating
      // on count > 0 (not >= TOP_N) handles anonymous parses and low-population
      // bosses that can never fill a full TOP_N slot.
      const samplesPath = getSamplesPath(spec, enc.id);
      const existingSamples = await readJson<ParseSample[]>(samplesPath) ?? [];
      if (existingSamples.length > 0) {
        const allFresh = existingSamples.every(s => s.ingest_hash === INGEST_HASH);
        if (allFresh) {
          const newestMs = Math.max(...existingSamples.map(s => new Date(s.sampled_at ?? 0).getTime()));
          const ageH = (Date.now() - newestMs) / 3_600_000;
          if (ageH < FRESH_HOURS) {
            console.log(`\n[${enc.name}] Skipped (${existingSamples.length} samples fresh, ${Math.round(ageH * 10) / 10}h old)`);
            continue;
          }
        }
      }

      // Check budget before spending a query on rankings.
      await wcl.assertBudget(POINTS_MARGIN);

      process.stdout.write(`\n[${enc.name}] Fetching top ${TOP_N} rankings...`);
      let rankings: ParseRanking[];
      try {
        rankings = await fetchRankingsLite(wcl, spec, enc.id, TOP_N, enc.partitionIds ?? []);
      } catch (err) {
        if (err instanceof BudgetExceededError) throw err;
        console.log(` FAILED: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      console.log(` ${rankings.length} rankings found`);

      // Build set of cached parse keys
      const cachedKeys = new Set<string>((await readJson<ParseSample[]>(getSamplesPath(spec, enc.id)) ?? []).map(s => parseKey(s.report_code, s.fight_id)));
      const uncached = rankings.filter(ranking => !cachedKeys.has(parseKey(ranking.report_code, ranking.fight_id)));
      const cached = rankings.length - uncached.length;

      // Fetch + analyze uncached parses concurrently (bounded by PARSE_CONCURRENCY)
      // since the work is network-bound. Each task only fetches/analyzes and returns
      // its result; the shared per-encounter sample/position files are written
      // sequentially AFTER the batch to avoid a read-modify-write race.
      const limit = pLimit(PARSE_CONCURRENCY);
      let completed = 0;
      const settled = await Promise.allSettled(uncached.map(ranking => limit(async () => {
        // Budget gate before each parse's network work; throws BudgetExceededError
        // to stop the run cleanly once the hourly point budget runs low.
        await wcl.assertBudget(POINTS_MARGIN);
        const enriched = await enrichRanking(wcl, ranking);
        const res = await analyzeParse(wcl, spec, ranking.report_code, ranking.fight_id, ranking.player, enriched.combatant_info);
        completed++;
        process.stdout.write(`\r  [${enc.name}] Analyzed ${completed}/${uncached.length}...    `);
        return res;
      })));

      // Persist results sequentially (in ranking order) - no concurrent writes.
      let budgetErr: BudgetExceededError | null = null;
      for (let i = 0; i < settled.length; i++) {
        const outcome = settled[i];
        if (outcome.status === 'fulfilled') {
          const res = outcome.value;
          if (res?.cooldown_data) {
            const ranking = uncached[i];
            await saveParseSample(spec, enc.id, enc.name, ranking.report_code, ranking.fight_id, ranking.player, res.cooldown_data);
            await savePositions(spec, enc.id, enc.name, res.positions);
          }
        } else if (outcome.reason instanceof BudgetExceededError) {
          budgetErr = outcome.reason;
        } else {
          const reason = outcome.reason;
          process.stdout.write(` (skip ${uncached[i].player}: ${reason instanceof Error ? reason.message.slice(0, 40) : String(reason)})`);
        }
      }
      process.stdout.write(`\r  [${enc.name}] ${uncached.length} analyzed, ${cached} cached.          \n`);

      // Partial progress for this encounter is now committed; surface the budget
      // stop so the outer handler can exit cleanly.
      if (budgetErr) throw budgetErr;

      process.stdout.write(`  [${enc.name}] Computing bench data...`);
      await syncEncounterFile(spec, enc.id);
      await resolveEnchantNames(wcl, spec, enc.id);
      console.log(' done');
    }
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      console.log(`\n[budget] Stopping cleanly: ${err.message}`);
      console.log('[budget] Partial progress committed; remaining work picked up next run.');
      await writeSpecIndex();
      return true;
    }
    throw err;
  }
  await writeSpecIndex();
  console.log(`\nIngestion complete for ${spec}.`);
  return false;
}

async function main(): Promise<void> {
  console.log('warcraft-learner - Parse Ingestion CLI');

  let wcl: WCLClient;
  try {
    wcl = new WCLClient();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  process.stdout.write('Fetching WCL encounters...');
  let encounters: IngestEncounter[];
  try {
    encounters = await getEncounters(wcl);
    console.log(` ${encounters.length} encounters in current expansion`);
  } catch (err) {
    console.error(`\nFailed to fetch encounters: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const specArg = opts.spec ?? null;

  let specs: string[];
  if (specArg) {
    if (!SPEC_TO_WCL[specArg]) {
      console.error(`Unknown spec "${specArg}". Known specs: ${Object.keys(SPEC_TO_WCL).join(', ')}`);
      process.exit(1);
    }
    specs = [specArg];
    console.log(`Targeting spec: ${specArg}`);
  } else {
    specs = await specsByStaleness(encounters);
    if (!specs.length) {
      console.log('No known specs (no rulebook.json found). Nothing to do.');
      return;
    }
    console.log(`Stalest-first: ${specs.join(', ')}`);
  }

  for (const spec of specs) {
    const budgetExhausted = await ingestSpecNonInteractive(wcl, spec, encounters);
    if (budgetExhausted) break;
  }
}

main().catch(err => {
  console.error('\nFatal error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
