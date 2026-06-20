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

// ── Paths ─────────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FRONTEND_ROOT = path.resolve(__dirname, '..');
// WL_DATA_DIR lets a test/dry run write elsewhere instead of the committed data dir.
const DATA_DIR = process.env.WL_DATA_DIR || path.join(FRONTEND_ROOT, 'public', 'data', 'specs');

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

const BLOODLUST_SPELL_IDS = new Set([2825, 32182, 80353, 90355, 264667, 390386]);

const SPEC_TO_WCL = {
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

const EXCLUDE_ZONE_PATTERNS = ['beta', 'ptr', 'mythic+', 'complete raids', 'delves', 'torghast'];

// Skip encounters whose samples were all refreshed within this window.
const FRESH_HOURS = 23;
// Stop cleanly when fewer than this many WCL points remain in the hour.
const POINTS_MARGIN = 500;

// ── WCL OAuth2 client ─────────────────────────────────────────────────────────

// Thrown when the WCL hourly point budget is (about to be) exhausted. The ingest
// loop catches this to stop cleanly and commit partial progress; the remaining work
// is picked up on the next run. We do NOT retry: the limit resets on an hourly
// boundary and an hourly task must not stall waiting for it.
class BudgetExceededError extends Error {
  constructor(msg) { super(msg); this.name = 'BudgetExceededError'; }
}

class WCLClient {
  constructor() {
    this.clientId = process.env.WCL_CLIENT_ID || '';
    this.clientSecret = process.env.WCL_CLIENT_SECRET || '';
    if (!this.clientId || !this.clientSecret) {
      throw new Error('WCL_CLIENT_ID and WCL_CLIENT_SECRET environment variables must be set');
    }
    this._token = null;
    this._tokenExpiry = 0;
    this._serverSlugCache = new Map();
    // Live rate-limit state, refreshed lazily via assertBudget().
    this._limitPerHour = null;
    this._pointsSpentThisHour = 0;
  }

  async _getToken() {
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
    const data = await res.json();
    this._token = data.access_token;
    this._tokenExpiry = Date.now() / 1000 + (data.expires_in ?? 3600);
    return this._token;
  }

  async query(gql, variables = {}) {
    const token = await this._getToken();
    const res = await fetch(WCL_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ query: gql, variables }),
    });
    if (!res.ok) {
      const text = await res.text();
      if (res.status === 429) throw new BudgetExceededError(`WCL rate limit hit (429): ${text.slice(0, 200)}`);
      throw new Error(`WCL API error ${res.status}: ${text.slice(0, 300)}`);
    }
    const body = await res.json();
    if (body.errors) {
      const msg = JSON.stringify(body.errors);
      if (/rate.?limit|too many requests|exhausted/i.test(msg)) {
        throw new BudgetExceededError(`WCL rate limit (GraphQL): ${msg.slice(0, 200)}`);
      }
      throw new Error(`GraphQL error: ${msg}`);
    }
    return body.data;
  }

  // Reads the live hourly point budget and caches it on the instance.
  async getRateLimit() {
    const data = await this.query(
      'query { rateLimitData { limitPerHour pointsSpentThisHour pointsResetIn } }',
    );
    const rl = (data || {}).rateLimitData || {};
    if (rl.limitPerHour != null) this._limitPerHour = rl.limitPerHour;
    if (rl.pointsSpentThisHour != null) this._pointsSpentThisHour = rl.pointsSpentThisHour;
    return { limitPerHour: this._limitPerHour, pointsSpentThisHour: this._pointsSpentThisHour, pointsResetIn: rl.pointsResetIn ?? null };
  }

  // Fetches live budget then throws BudgetExceededError if remaining points < margin.
  async assertBudget(margin) {
    const { limitPerHour, pointsSpentThisHour } = await this.getRateLimit();
    if (limitPerHour == null) return; // unknown - don't block
    const remaining = limitPerHour - pointsSpentThisHour;
    if (remaining < margin) {
      throw new BudgetExceededError(
        `WCL budget low: ${remaining} of ${limitPerHour} remaining (need ${margin})`,
      );
    }
  }

  async getAllEvents(code, fightId, dataType, startTime, endTime, options = {}) {
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
    const events = [];
    let currentStart = startTime;
    while (true) {
      const vars = { code, fightIDs: [fightId], dataType, startTime: currentStart, endTime };
      if (options.sourceId != null) vars.sourceID = options.sourceId;
      if (options.targetId != null) vars.targetID = options.targetId;
      if (options.includeResources) vars.includeResources = true;
      if (options.hostilityType) vars.hostilityType = options.hostilityType;
      const data = await this.query(EVENTS_QUERY, vars);
      const page = data.reportData.report.events;
      if (page.data) events.push(...page.data);
      if (page.nextPageTimestamp == null) break;
      currentStart = page.nextPageTimestamp;
    }
    return events;
  }

  async resolveServerSlug(serverId) {
    if (this._serverSlugCache.has(serverId)) return this._serverSlugCache.get(serverId);
    const SERVER_QUERY = `query($id: Int!) { worldData { server(id: $id) { slug region { slug } } } }`;
    try {
      const data = await this.query(SERVER_QUERY, { id: serverId });
      const srv = (data.worldData || {}).server || {};
      const result = [(srv.slug || '').toLowerCase(), ((srv.region || {}).slug || '').toLowerCase()];
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

const REPORT_META_QUERY = `
query($code: String!) {
  reportData { report(code: $code) {
    fights(killType: Kills) { id startTime endTime encounterID }
    masterData { actors(type: "Player") { id name subType } }
  }}
}`;

const CHAR_ENC_RANKINGS_QUERY = `
query($name: String!, $serverSlug: String!, $serverRegion: String!, $encID: Int!) {
  characterData {
    character(name: $name, serverSlug: $serverSlug, serverRegion: $serverRegion) {
      encounterRankings(encounterID: $encID, includeCombatantInfo: true)
    }
  }
}`;

// ── Encounter fetching ────────────────────────────────────────────────────────

async function getEncounters(wcl) {
  const data = await wcl.query(ENCOUNTERS_QUERY);
  const expansions = data.worldData.expansions;

  // Current expansion: newest (first returned), detect by first unique name
  // Build a flat list of all expansions sorted newest first (WCL returns newest first)
  // Find current expansion: first expansion whose name doesn't repeat in a later one
  // Simple approach: take the first expansion (newest) and find its unique zone names
  const seenZoneNames = new Set();
  let currentExpName = null;
  for (const exp of expansions) {
    for (const zone of (exp.zones || [])) {
      if (!seenZoneNames.has(zone.name)) {
        seenZoneNames.add(zone.name);
      }
    }
    if (currentExpName === null) currentExpName = exp.name;
  }

  // Collect encounters from current expansion, filtering excluded zones
  const result = [];
  const firstExp = expansions[0];
  if (!firstExp) return result;

  for (const zone of (firstExp.zones || [])) {
    const lname = zone.name.toLowerCase();
    if (EXCLUDE_ZONE_PATTERNS.some(p => lname.includes(p))) continue;
    // Sort partition IDs descending (highest = newest first) so we try the
    // most recent patch partition first and fall back to older ones when the
    // new partition is empty (e.g. right after a patch drops).
    const partitionIds = (zone.partitions || [])
      .map(p => p.id)
      .sort((a, b) => b - a);
    for (const enc of (zone.encounters || [])) {
      result.push({ id: enc.id, name: enc.name, zone: zone.name, expansion: firstExp.name, partitionIds });
    }
  }
  return result;
}

// ── Talent extraction ─────────────────────────────────────────────────────────

const TRINKET_INDICES = new Set([12, 13]);

// Trinkets (gear slots 12/13) and permanent enchants. Gear shape is identical
// across both ranking APIs, so this is shared.
function extractGear(rankingEntry) {
  const gear = rankingEntry.gear || [];
  const trinkets = [];
  const enchants = [];
  const gems = [];
  for (let idx = 0; idx < gear.length; idx++) {
    const item = gear[idx];
    if (!item || !item.id) continue;
    const itemId = parseInt(item.id) || item.id;
    const name = item.name || '';

    if (TRINKET_INDICES.has(idx)) {
      trinkets.push({ slot: idx, id: itemId, name });
    }

    const encRaw = item.permanentEnchant;
    if (encRaw) {
      const encId = parseInt(encRaw) || encRaw;
      enchants.push({ slot: idx, id: encId, name: item.permanentEnchantName || '' });
    }

    // Which gems are best is a sim question, so we do not track gem ids - only
    // how many sockets are filled, to flag empty sockets against the top-parse
    // typical gem count.
    for (const g of (item.gems || [])) {
      const gid = parseInt(g && g.id) || (g && g.id);
      if (gid) gems.push({ slot: idx, id: gid });
    }
  }
  return { trinkets, enchants, gems };
}

// `characterRankings` talents - old WCL format: [{talentID: N, points: P}].
function talentKeyV1(talents) {
  if (!Array.isArray(talents) || !talents.length) return '';
  const ids = talents
    .filter(t => t)
    .map(t => String(t.talentID || t.id || ''))
    .filter(x => x)
    .sort();
  return ids.length ? 'v1:' + ids.join(',') : '';
}

// `encounterRankings` talents - Midnight format: {class:{row:[{node:{nodeId}}]}, spec:{...}}.
function talentKeyV2(talents) {
  if (!talents || typeof talents !== 'object') return '';
  const nodeIds = [];
  for (const sectionKey of ['class', 'spec']) {
    const section = talents[sectionKey] || {};
    if (typeof section !== 'object') continue;
    for (const rowNodes of Object.values(section)) {
      if (!Array.isArray(rowNodes)) continue;
      for (const entry of rowNodes) {
        const nid = (entry.node || {}).nodeId;
        if (nid) nodeIds.push(String(nid));
      }
    }
  }
  return nodeIds.length ? 'v2:' + nodeIds.sort().join(',') : '';
}

async function fetchV2Talent(wcl, name, serverSlug, serverRegion, encounterId) {
  if (!name || !serverSlug || !serverRegion) return '';
  try {
    const data = await wcl.query(CHAR_ENC_RANKINGS_QUERY, {
      name, serverSlug, serverRegion, encID: encounterId,
    });
    let raw = ((data.characterData || {}).character || {}).encounterRankings;
    if (raw == null) return '';
    const rankingsData = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const ranks = (rankingsData.ranks || []);
    if (!ranks.length) return '';
    const mostRecent = ranks.reduce((a, b) => (a.startTime || 0) > (b.startTime || 0) ? a : b);
    return talentKeyV2(mostRecent.talents);
  } catch {
    return '';
  }
}

// ── Rankings fetching ─────────────────────────────────────────────────────────

// Cheap rankings fetch: 1 API query. Returns raw ranking objects with an
// additional `_raw` field so the caller can extract gear/v1-talent later.
// Server slug + v2 talent are NOT fetched here - defer to enrichRanking().
async function fetchRankingsLite(wcl, spec, encounterId, count = 10, partitionIds = []) {
  const mapping = SPEC_TO_WCL[spec];
  if (!mapping) throw new Error(`Unknown spec: ${spec}`);
  const [className, specName] = mapping;

  // Try partitions newest-first; fall back to null (current) when zone has none.
  const attempts = partitionIds.length > 0 ? partitionIds : [null];
  let rawRankings = [];
  for (const partition of attempts) {
    const data = await wcl.query(RANKINGS_QUERY, { encounterID: encounterId, className, specName, partition });
    const enc = data.worldData.encounter;
    const raw = enc.characterRankings;
    const rankingsData = typeof raw === 'string' ? JSON.parse(raw) : raw;
    // Filter anonymous parses (report: null) before slicing - the full page is
    // already in the response, so this costs zero extra queries and ensures we
    // always get TOP_N public (fetchable) parses rather than wasting a slot on
    // a parse we can never access.
    rawRankings = (rankingsData.rankings || []).filter(r => (r.report || {}).code).slice(0, count);
    if (rawRankings.length > 0) break;
  }

  return rawRankings.map((r, i) => ({
    rank: i + 1,
    player: r.name,
    amount: Math.round(r.amount || 0),
    duration_s: Math.round((r.duration || 0) / 100) / 10,
    report_code: (r.report || {}).code,
    fight_id: (r.report || {}).fightID,
    server: (r.server || {}).name,
    _raw: r, // kept for enrichRanking(); not persisted
  }));
}

// Expensive per-player enrichment: resolves server slug (1 query, in-memory
// cached per server) + fetches v2 talent key (1 query). Only called for
// uncached parses - cached parses reuse combatant_info already on disk.
async function enrichRanking(wcl, ranking, encounterId) {
  const r = ranking._raw;
  const sid = (r.server || {}).id;
  const [serverSlug, serverRegion] = sid ? await wcl.resolveServerSlug(sid) : ['', ''];
  const v2Key = await fetchV2Talent(wcl, r.name || '', serverSlug, serverRegion, encounterId);
  const talent_key = v2Key || talentKeyV1(r.talents);
  return {
    server_slug: serverSlug,
    server_region: serverRegion,
    combatant_info: { talent_key, ...extractGear(r) },
  };
}

// ── Burst window analysis ─────────────────────────────────────────────────────

function findBurstWindows(damageEvents, fightStartMs, cdSummary, specCds, minPctThreshold = 0.03) {
  const hits = damageEvents
    .filter(e => e.type === 'damage' && (e.amount || 0) + (e.absorbed || 0) > 0)
    .map(e => [e.timestamp, (e.amount || 0) + (e.absorbed || 0), e.targetID || 0, e.abilityGameID || 0])
    .sort((a, b) => a[0] - b[0]);

  if (!hits.length) return [];
  const total = hits.reduce((s, h) => s + h[1], 0);
  if (!total) return [];

  // Build windows from CD cast times × CD durations
  const rawWins = [];
  for (const cdEntry of (cdSummary || [])) {
    const cdDef = specCds?.find(c => c.name === cdEntry.name);
    const dur = cdDef?.duration || 0;
    if (dur <= 0) continue;
    for (const castS of (cdEntry.cast_times_s || [])) {
      rawWins.push({ startS: castS, endS: castS + dur, cdNames: [cdEntry.name] });
    }
  }
  if (!rawWins.length) return [];

  // Merge overlapping or near-adjacent windows (≤3s gap)
  rawWins.sort((a, b) => a.startS - b.startS);
  const merged = [{ ...rawWins[0], cdNames: [...rawWins[0].cdNames] }];
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

  const result = [];
  for (const win of merged) {
    const startMs = fightStartMs + win.startS * 1000;
    const endMs = fightStartMs + win.endS * 1000;
    const windowHits = hits.filter(h => h[0] >= startMs && h[0] <= endMs);
    const windowDmg = windowHits.reduce((s, h) => s + h[1], 0);
    if (!windowDmg || windowDmg / total < minPctThreshold) continue;

    const abilityDmg = new Map();
    for (const [, dmg, , aid] of windowHits) {
      if (aid) abilityDmg.set(aid, (abilityDmg.get(aid) || 0) + dmg);
    }
    const topAbilities = [...abilityDmg.entries()]
      .sort((a, b) => b[1] - a[1]).slice(0, 6)
      .map(([sid, d]) => ({ spell_id: sid, damage: d, pct: Math.round(d / windowDmg * 1000) / 1000 }));

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

function findDefensiveWindows(damageTakenEvents, fightStartMs, buffWindows, specDefensives, npcById) {
  const hits = damageTakenEvents
    .filter(e => e.type === 'damage' && (e.amount || 0) + (e.absorbed || 0) > 0)
    .map(e => [e.timestamp, (e.amount || 0) + (e.absorbed || 0), e.abilityGameID || 0, e.sourceID ?? null])
    .sort((a, b) => a[0] - b[0]);

  if (!hits.length) return [];
  const total = hits.reduce((s, h) => s + h[1], 0);
  if (!total) return [];

  const result = [];

  for (const defn of specDefensives) {
    const sid = defn.spell_id;
    const dur = defn.duration || 5;

    for (const bw of (buffWindows.get(sid) || [])) {
      // buffWindows store relative-seconds from fight start
      const startS = bw[0];
      const endS = bw[1] != null ? bw[1] : startS + dur;
      const startMs = fightStartMs + startS * 1000;
      const endMs = fightStartMs + endS * 1000;

      const windowHits = hits.filter(h => h[0] >= startMs && h[0] <= endMs);
      const windowDmg = windowHits.reduce((s, h) => s + h[1], 0);
      const pct = total ? Math.round(windowDmg / total * 1000) / 1000 : 0;

      const abilityDmg = new Map();
      for (const [, dmg, aid] of windowHits) {
        if (aid) abilityDmg.set(aid, (abilityDmg.get(aid) || 0) + dmg);
      }
      const topAbilities = [...abilityDmg.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([abilityId, d]) => ({
          spell_id: abilityId,
          damage: d,
          pct: windowDmg ? Math.round(d / windowDmg * 1000) / 1000 : 0,
        }));

      // Reference for the map = the enemy that dealt the most damage in the window.
      const dmgBySource = new Map();
      for (const [, dmg, , src] of windowHits) {
        if (src != null && npcById?.has(src)) dmgBySource.set(src, (dmgBySource.get(src) || 0) + dmg);
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
        ref_game_id: refGameId,
      });
    }
  }

  return result.sort((a, b) => a.time_s - b.time_s);
}

// Defensive windows cluster per-defensive first (so Cloak at 1:00 and Feint at 1:00
// remain separate clusters), then by time within each defensive group.
function clusterDefensiveWindows(windows, totalSamples, mergeS = 20.0) {
  if (!windows.length) return [];
  const byDefensive = new Map();
  for (const w of windows) {
    const name = w.defensive_name || w.active_cds?.[0] || '';
    if (!byDefensive.has(name)) byDefensive.set(name, []);
    byDefensive.get(name).push(w);
  }
  const result = [];
  for (const [defensiveName, defWindows] of byDefensive.entries()) {
    for (const cl of groupByTime(defWindows, mergeS)) {
      if (cl.length < Math.max(2, totalSamples * 0.35)) continue;
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

function loadRulebook(spec) {
  const rbPath = path.join(DATA_DIR, spec, 'rulebook.json');
  if (!fs.existsSync(rbPath)) return null;
  try { return JSON.parse(fs.readFileSync(rbPath, 'utf8')); } catch { return null; }
}

function getSpecCooldowns(spec) {
  const rb = loadRulebook(spec);
  if (rb && rb.major_cooldowns && rb.major_cooldowns.length > 0) return rb.major_cooldowns;
  return null;
}

function getSpecDefensives(spec) {
  const rb = loadRulebook(spec);
  if (rb && rb.defensives && rb.defensives.length > 0) return rb.defensives;
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

function posActorId(e) {
  if (typeof e.x !== 'number' || typeof e.y !== 'number') return null;
  return e.resourceActor === 2 ? e.targetID : e.sourceID;
}

/** Boss actor id = the NPC with the highest maxHitPoints across resource snapshots. */
function pickBossActorId(events, npcById) {
  const maxHp = new Map();
  for (const e of events) {
    const id = posActorId(e);
    if (id == null || !npcById.has(id)) continue;
    const hp = typeof e.maxHitPoints === 'number' ? e.maxHitPoints : 0;
    if (hp > (maxHp.get(id) ?? -1)) maxHp.set(id, hp);
  }
  let bossId = null, best = -1;
  for (const [id, hp] of maxHp) if (hp > best) { best = hp; bossId = id; }
  return bossId;
}

/** Group raw position samples per actor id from resource-bearing events. */
function collectPositionSamples(events, fightStartMs) {
  const byActor = new Map();
  for (const e of events) {
    const id = posActorId(e);
    if (id == null) continue;
    let arr = byActor.get(id);
    if (!arr) { arr = []; byActor.set(id, arr); }
    arr.push({
      t: (e.timestamp - fightStartMs) / 1000,
      x: e.x, y: e.y,
      facing: typeof e.facing === 'number' ? e.facing : null,
      mapID: typeof e.mapID === 'number' ? e.mapID : null,
      maxHp: typeof e.maxHitPoints === 'number' ? e.maxHitPoints : 0,
    });
  }
  for (const arr of byActor.values()) arr.sort((a, b) => a.t - b.t);
  return byActor;
}

/** Resample to a fixed cadence: [t, x, y, facing, mapID] rows, linear for x/y, nearest for facing/mapID. */
function resampleTimeline(samples, durationS, intervalS) {
  if (!samples.length) return [];
  const first = samples[0].t, last = samples[samples.length - 1].t;
  const out = [];
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
function buildParsePositions(reportCode, fightId, playerName, playerId, npcById, posEvents, fightStartMs, durationS) {
  const byActor = collectPositionSamples(posEvents, fightStartMs);
  const playerSamples = byActor.get(playerId) || [];

  const enemies = [];
  for (const [id, samples] of byActor) {
    if (id === playerId || !npcById.has(id)) continue;
    const maxHp = samples.reduce((m, s) => Math.max(m, s.maxHp), 0);
    enemies.push({ actorId: id, count: samples.length, maxHp, samples, meta: npcById.get(id) });
  }
  enemies.sort((a, b) => b.count - a.count);
  const bossId = enemies.reduce((best, e) => (e.maxHp > (best?.maxHp ?? -1) ? e : best), null)?.actorId;
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
      name: e.meta.name || '',
      is_boss: e.actorId === bossId,
      samples: resampleTimeline(e.samples, durationS, POSITIONS_INTERVAL_S),
    })).filter(e => e.is_boss || e.samples.length >= MIN_ENEMY_SAMPLES),
  };
}

async function analyzeParse(wcl, spec, reportCode, fightId, playerName, combatantInfo) {
  const specCds = getSpecCooldowns(spec) || [];
  const specDefensives = getSpecDefensives(spec);

  let meta;
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
  const npcById = new Map(actors.filter(a => a.type !== 'Player').map(a => [a.id, a]));

  const start = fight.startTime;
  const end = fight.endTime;
  const fightDurS = (end - start) / 1000;

  // Fetch all event types in parallel. Positions ride along on the (smaller)
  // Casts streams via includeResources, keeping the dense damage streams plain.
  // The boss reference gets one targeted DamageDone stream below (single actor),
  // which is far cheaper than fetching every enemy's damage with resources.
  let castEvents, buffEvents, damageEvents, damageTakenEvents, enemyCastEvents;
  try {
    [castEvents, buffEvents, damageEvents, damageTakenEvents, enemyCastEvents] = await Promise.all([
      wcl.getAllEvents(reportCode, fightId, 'Casts',       start, end, { sourceId: player.id, includeResources: true }),
      wcl.getAllEvents(reportCode, fightId, 'Buffs',       start, end, { targetId: player.id }),
      wcl.getAllEvents(reportCode, fightId, 'DamageDone',  start, end, { sourceId: player.id }),
      wcl.getAllEvents(reportCode, fightId, 'DamageTaken', start, end, { sourceId: player.id }),
      wcl.getAllEvents(reportCode, fightId, 'Casts',       start, end, { includeResources: true, hostilityType: 'Enemies' }).catch(() => []),
    ]);
  } catch {
    return null;
  }

  // Dense boss positions from a single targeted stream (boss auto-attacks),
  // identified as the highest-maxHitPoints enemy in the enemy cast snapshots.
  let bossDamageEvents = [];
  const bossActorId = pickBossActorId(enemyCastEvents, npcById);
  if (bossActorId != null) {
    bossDamageEvents = await wcl
      .getAllEvents(reportCode, fightId, 'DamageDone', start, end, { sourceId: bossActorId, includeResources: true })
      .catch(() => []);
  }

  // Detect Bloodlust
  let blTimeS = null;
  for (const e of buffEvents) {
    if (e.type === 'applybuff' && BLOODLUST_SPELL_IDS.has(e.abilityGameID)) {
      blTimeS = (e.timestamp - start) / 1000;
      break;
    }
  }

  // Per-CD analysis
  const cdSummary = [];
  for (const cd of specCds) {
    const cdCasts = castEvents
      .filter(c => c.type === 'cast' && c.abilityGameID === cd.spell_id)
      .sort((a, b) => a.timestamp - b.timestamp);

    const castTimesS = cdCasts.map(c => (c.timestamp - start) / 1000);
    const firstCastS = castTimesS.length > 0 ? castTimesS[0] : null;

    let blAligned = false;
    let blOffsetS = null;
    if (blTimeS != null && castTimesS.length > 0) {
      for (const t of castTimesS) {
        if (blTimeS - 30 <= t && t <= blTimeS + 55) { blAligned = true; break; }
      }
      const windowOffsets = castTimesS
        .filter(t => blTimeS - 30 <= t && t <= blTimeS + 55)
        .map(t => t - blTimeS);
      if (windowOffsets.length > 0) {
        blOffsetS = Math.round(windowOffsets.reduce((best, v) => Math.abs(v) < Math.abs(best) ? v : best) * 10) / 10;
      }
    }

    // Hold pattern
    const holdWindows = [];
    if (castTimesS.length > 1) {
      const cdSeconds = cd.cooldown || 90;
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
  let castEffPct = null;
  let castGapListMs = [];
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
  const burstWindows = findBurstWindows(damageEvents, start, cdSummary, specCds);

  // Gear data from combatant info
  // combatant_info already carries parsed { talent_key, trinkets, enchants } from fetchTopRankings.
  const gearData = combatantInfo || {};

  // Defensive tracking
  // Build buff window lookup: Map<spell_id, [[start_s, end_s|null], ...]>
  const buffWindows = new Map();
  for (const e of buffEvents) {
    const sid = e.abilityGameID;
    const tS = (e.timestamp - start) / 1000;
    if (e.type === 'applybuff') {
      if (!buffWindows.has(sid)) buffWindows.set(sid, []);
      buffWindows.get(sid).push([tS, null]);
    } else if (e.type === 'removebuff') {
      const windows = buffWindows.get(sid) || [];
      for (let i = windows.length - 1; i >= 0; i--) {
        if (windows[i][1] == null) { windows[i][1] = tS; break; }
      }
    }
  }

  const defensiveSummary = [];
  for (const defn of specDefensives) {
    const sid = defn.spell_id;
    const duration = defn.duration || 0;
    const cooldownS = defn.cooldown || 90;
    const windows = [];
    let castTimes = [];

    for (const bw of (buffWindows.get(sid) || [])) {
      const wStart = bw[0];
      const wEnd = bw[1] != null ? bw[1] : (duration ? wStart + duration : wStart + 5);
      const dmgDuring = damageTakenEvents
        .filter(e => e.type === 'damage')
        .reduce((s, e) => {
          const tS = (e.timestamp - start) / 1000;
          return tS >= wStart && tS <= wEnd ? s + (e.amount || 0) + (e.absorbed || 0) : s;
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
            return eS >= tS && eS <= wEnd ? s + (e.amount || 0) + (e.absorbed || 0) : s;
          }, 0);
        windows.push({ start_s: tS, end_s: Math.round(wEnd * 10) / 10, dmg_during: Math.round(dmgDuring) });
        castTimes.push(tS);
      }
    }

    castTimes.sort((a, b) => a - b);
    const holdWindowsDef = [];
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

  // Damage taken analysis
  const abilityDmgTaken = new Map();
  let totalDmgTaken = 0;

  for (const e of damageTakenEvents) {
    if (e.type !== 'damage') continue;
    const amt = (e.amount || 0) + (e.absorbed || 0);
    if (!amt) continue;
    totalDmgTaken += amt;
    const sid = e.abilityGameID;
    if (sid) abilityDmgTaken.set(sid, (abilityDmgTaken.get(sid) || 0) + amt);
  }

  const topDmgAbilities = [...abilityDmgTaken.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([sid, dmg]) => ({
      spell_id: sid,
      damage: dmg,
      pct: totalDmgTaken ? Math.round(dmg / totalDmgTaken * 1000) / 1000 : 0,
    }));

  const cooldownData = {
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
    dmg_taken_by_ability: topDmgAbilities,
    total_dmg_taken: totalDmgTaken,
    talent_key: gearData.talent_key || '',
    trinkets: gearData.trinkets || [],
    enchants: gearData.enchants || [],
    gems: gearData.gems || [],
  };

  let positions = null;
  try {
    positions = buildParsePositions(
      reportCode, fightId, player.name, player.id, npcById,
      [...castEvents, ...enemyCastEvents, ...bossDamageEvents], start, fightDurS,
    );
    if (!positions.player.length) positions = null;
  } catch { positions = null; }

  return { cooldown_data: cooldownData, positions };
}

// ── Analysis utils (JS port of analysis_utils.py) ────────────────────────────

function median(arr) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function stdev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1));
}

function round(v, decimals = 1) {
  return Math.round(v * 10 ** decimals) / 10 ** decimals;
}

// ── Shared clustering primitives ─────────────────────────────────────────────

// Greedy: group windows by proximity in time (within mergeS seconds of running cluster median).
function groupByTime(windows, mergeS) {
  const sorted = [...windows].sort((a, b) => a.time_s - b.time_s);
  const clusters = [];
  for (const w of sorted) {
    let placed = false;
    for (const cl of clusters) {
      if (Math.abs(w.time_s - median(cl.map(c => c.time_s))) <= mergeS) {
        cl.push(w); placed = true; break;
      }
    }
    if (!placed) clusters.push([w]);
  }
  return clusters;
}

// Common statistics for a cluster of windows (time, absolute damage, ability breakdown).
// Windows are compared by absolute damage rather than share-of-fight-total: on
// progression (wipes) the fight-total denominator is unstable, so a share would
// inflate against full-kill top parses. Absolute damage stays comparable.
function clusterBaseStats(cl, totalSamples) {
  const times = cl.map(c => c.time_s);
  const dmgs  = cl.map(c => c.window_damage || 0);
  const sorted = [...dmgs].sort((a, b) => a - b);

  const abilityTotals = new Map();
  for (const c of cl) {
    for (const ab of (c.ability_breakdown || [])) {
      if (!abilityTotals.has(ab.spell_id)) abilityTotals.set(ab.spell_id, []);
      abilityTotals.get(ab.spell_id).push(ab.damage || 0);
    }
  }
  const ability_breakdown = [...abilityTotals.entries()]
    .filter(([, ds]) => ds.length >= cl.length * 0.5)
    .map(([sid, ds]) => ({
      spell_id: sid,
      avg_damage: Math.round(mean(ds)),
      min_damage: Math.round(Math.min(...ds)),
      max_damage: Math.round(Math.max(...ds)),
      count: ds.length,
    }))
    .sort((a, b) => b.avg_damage - a.avg_damage)
    .slice(0, 6);

  // Majority map-reference enemy across members (defensive windows only; null for burst).
  const refCounts = new Map();
  for (const c of cl) if (c.ref_game_id != null) refCounts.set(c.ref_game_id, (refCounts.get(c.ref_game_id) || 0) + 1);
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

// ─────────────────────────────────────────────────────────────────────────────

function clusterBurstWindows(windows, totalSamples, mergeS = 15.0) {
  if (!windows.length) return [];
  const result = [];
  for (const cl of groupByTime(windows, mergeS)) {
    if (cl.length < Math.max(2, totalSamples * 0.35)) continue;
    const base = clusterBaseStats(cl, totalSamples);
    const cdCounts = new Map();
    for (const c of cl) {
      for (const name of (c.active_cds || [])) cdCounts.set(name, (cdCounts.get(name) || 0) + 1);
    }
    const common_cds = [...cdCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .filter(([, cnt]) => cnt >= cl.length * 0.5)
      .map(([name]) => name);
    const window_length_s = round(mean(cl.map(c => c.window_length_s)));
    result.push({ ...base, common_cds, avg_targets: round(mean(cl.map(c => c.target_count || 1))), window_length_s });
  }
  return result.sort((a, b) => a.time_s - b.time_s);
}

function aggregateGear(samples) {
  const total = samples.length;
  const talentCounter = new Map();
  const talentExample = new Map();
  const trinketCounters = { 12: new Map(), 13: new Map() };
  const trinketNames = new Map();
  const enchantCounters = new Map();
  const enchantNames = new Map();
  const gemCounts = [];

  for (const s of samples) {
    const cdData = s.cooldown_data || {};
    const tk = cdData.talent_key || '';
    if (tk) {
      talentCounter.set(tk, (talentCounter.get(tk) || 0) + 1);
      if (!talentExample.has(tk)) {
        talentExample.set(tk, {
          report_code: s.report_code || '',
          fight_id: s.fight_id,
          player_name: s.player_name || '',
        });
      }
    }

    for (const t of (cdData.trinkets || [])) {
      const slot = t.slot;
      const itemId = t.id;
      if ((slot === 12 || slot === 13) && itemId) {
        trinketCounters[slot].set(itemId, (trinketCounters[slot].get(itemId) || 0) + 1);
        if (!trinketNames.has(itemId)) trinketNames.set(itemId, t.name || '');
      }
    }

    for (const e of (cdData.enchants || [])) {
      const slot = e.slot;
      const encId = e.id;
      if (slot != null && encId) {
        if (!enchantCounters.has(slot)) enchantCounters.set(slot, new Map());
        enchantCounters.get(slot).set(encId, (enchantCounters.get(slot).get(encId) || 0) + 1);
        if (!enchantNames.has(encId)) enchantNames.set(encId, e.name || '');
      }
    }

    if (Array.isArray(cdData.gems)) gemCounts.push(cdData.gems.length);
  }

  const talentBuilds = [...talentCounter.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([k, c]) => ({
      key: k, count: c, pct: total ? Math.round(c / total * 100) : 0,
      ...(talentExample.get(k) || {}),
    }));

  const trinkets = {};
  for (const [slot, counter] of Object.entries(trinketCounters)) {
    if (!counter.size) continue;
    trinkets[slot] = [...counter.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([id, c]) => ({ id, name: trinketNames.get(id) || '', count: c, pct: total ? Math.round(c / total * 100) : 0 }));
  }

  const enchants = {};
  for (const [slot, counter] of enchantCounters.entries()) {
    if (!counter.size) continue;
    enchants[String(slot)] = [...counter.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([id, c]) => ({ id, name: enchantNames.get(id) || '', count: c, pct: total ? Math.round(c / total * 100) : 0 }));
  }

  // Socket count: top parsers are fully gemmed, so the max observed gem count is
  // the "all sockets filled" baseline; avg flags whether that is universal.
  const gems = gemCounts.length
    ? { avg_count: round(mean(gemCounts), 1), max_count: Math.max(...gemCounts), sample_count: gemCounts.length }
    : null;

  return { sample_count: total, talent_builds: talentBuilds, trinkets, enchants, gems };
}

// ── Enchant name resolution ───────────────────────────────────────────────────

/**
 * Patches missing enchant names in an already-written encounter bench file by
 * batch-querying WCL `gameData.enchant(id)` for each unique ID whose name is
 * empty. Uses GraphQL field aliases so all IDs are resolved in one round-trip.
 * Silently skips if the API does not support the query or returns no names.
 */
async function resolveEnchantNames(wcl, spec, encounterId) {
  const encPath = getEncounterPath(spec, encounterId);
  const data = readJson(encPath);
  if (!data || !data.gear || !data.gear.enchants) return;

  const enchantsMap = data.gear.enchants;
  const toResolve = new Map(); // id -> [{slot, idx}]
  for (const [slot, items] of Object.entries(enchantsMap)) {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.id && !item.name) {
        if (!toResolve.has(item.id)) toResolve.set(item.id, []);
        toResolve.get(item.id).push({ slot, idx: i });
      }
    }
  }
  if (!toResolve.size) return;

  const aliases = [...toResolve.keys()]
    .map(id => `e${id}: enchant(id: ${id}) { id name }`)
    .join('\n    ');
  const query = `query { gameData { ${aliases} } }`;

  try {
    const result = await wcl.query(query);
    const gameData = result?.gameData ?? {};
    let patched = false;
    for (const [id, locations] of toResolve.entries()) {
      const name = (gameData[`e${id}`]?.name || '').trim();
      if (!name) continue;
      for (const { slot, idx } of locations) {
        enchantsMap[slot][idx].name = name;
        patched = true;
      }
    }
    if (patched) writeJson(encPath, data);
  } catch {
    // gameData.enchant may not be available for all enchant IDs; keep empty names.
  }
}

// ── File I/O ──────────────────────────────────────────────────────────────────

function nowUtc() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return null; }
}

function writeJson(filePath, data, compact = false) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, compact ? 0 : 2), 'utf8');
}

function getSamplesPath(spec, encounterId) {
  return path.join(DATA_DIR, spec, 'parse_samples', `${encounterId}.json`);
}

function parseKey(reportCode, fightId, hash = INGEST_HASH) {
  return `${reportCode}:${fightId}:${hash}`;
}

function getEncounterPath(spec, encounterId) {
  return path.join(DATA_DIR, spec, 'encounters', `${encounterId}.json`);
}

function getPositionsPath(spec, encounterId) {
  return path.join(DATA_DIR, spec, 'positions', `${encounterId}.json`);
}

/** Append a parse's position timelines (deduped by report+fight) to the positions file. */
function savePositions(spec, encounterId, encounterName, positions) {
  if (!positions) return;
  const file = getPositionsPath(spec, encounterId);
  const existing = readJson(file) || {};
  let parses = Array.isArray(existing.parses) ? existing.parses : [];
  parses = parses.filter(p => !(p.report_code === positions.report_code && p.fight_id === positions.fight_id));
  parses.push(positions);
  writeJson(file, {
    spec, encounter_id: encounterId, encounter_name: encounterName,
    interval_s: POSITIONS_INTERVAL_S, sample_count: parses.length, parses,
  }, true);
}

function saveParseSample(spec, encounterId, encounterName, reportCode, fightId, playerName, cooldownData) {
  const samplesPath = getSamplesPath(spec, encounterId);
  let samples = readJson(samplesPath) || [];
  // Remove duplicate
  samples = samples.filter(s => !(s.report_code === reportCode && s.fight_id === fightId));
  samples.push({
    spec, encounter_id: encounterId, encounter_name: encounterName,
    report_code: reportCode, fight_id: fightId, player_name: playerName,
    sampled_at: nowUtc(), ingest_hash: INGEST_HASH, cooldown_data: cooldownData,
  });
  writeJson(samplesPath, samples);
}

function benchUsesPerMin(entries) {
  const upms = [];
  for (const e of entries) {
    const dur = e.fight_duration_s || 0;
    const times = e.cast_times_s || [];
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

function syncEncounterFile(spec, encounterId) {
  const samplesPath = getSamplesPath(spec, encounterId);
  const samples = readJson(samplesPath) || [];
  if (!samples.length) return;

  const encName = samples[0].encounter_name || '';

  // Efficiency
  const allGapsMs = [];
  for (const s of samples) {
    const gaps = (s.cooldown_data || {}).cast_gap_list_ms || [];
    allGapsMs.push(...gaps);
  }
  allGapsMs.sort((a, b) => a - b);
  let downtimeThresholdMs = 1500;
  if (allGapsMs.length) {
    const p90Idx = Math.max(0, Math.floor(0.90 * allGapsMs.length) - 1);
    downtimeThresholdMs = allGapsMs[p90Idx];
  }

  const effVals = [];
  for (const s of samples) {
    const cdData = s.cooldown_data || {};
    const gapList = cdData.cast_gap_list_ms || [];
    const durS = cdData.fight_duration_s || 0;
    if (gapList.length && durS > 0) {
      const dtS = gapList.filter(g => g > downtimeThresholdMs).reduce((s, g) => s + g, 0) / 1000;
      effVals.push(round(Math.max(0, (1 - dtS / durS) * 100)));
    }
  }
  if (!effVals.length) {
    for (const s of samples) {
      const v = (s.cooldown_data || {}).cast_efficiency_pct;
      if (v != null) effVals.push(v);
    }
  }
  const topAvgEfficiency = effVals.length ? round(mean(effVals)) : 0;
  const topEfficiencyStddev = effVals.length ? round(stdev(effVals)) : 0;

  // Per-CD benchmarks
  const agg = new Map();
  for (const s of samples) {
    const cdData = s.cooldown_data || {};
    const fightDur = cdData.fight_duration_s || 0;
    for (const cd of (cdData.cooldowns || [])) {
      if (!agg.has(cd.name)) agg.set(cd.name, []);
      agg.get(cd.name).push({ ...cd, fight_duration_s: fightDur });
    }
  }

  const perCdBenchmarks = {};
  for (const [cdName, entries] of agg.entries()) {
    const topFirstCasts = entries.map(e => e.first_cast_s).filter(v => v != null);
    const allCdGaps = [];
    for (const e of entries) {
      const times = e.cast_times_s || [];
      for (let j = 1; j < times.length; j++) allCdGaps.push(times[j] - times[j - 1]);
    }
    const blOffsets = entries.map(e => e.bl_offset_s).filter(v => v != null);

    const holdByCastIdx = new Map();
    for (const e of entries) {
      for (const hw of (e.hold_windows || [])) {
        if (!holdByCastIdx.has(hw.cast_index)) holdByCastIdx.set(hw.cast_index, []);
        holdByCastIdx.get(hw.cast_index).push(hw.actual_s);
      }
    }
    const holdTargets = {};
    for (const [castIdx, times] of holdByCastIdx.entries()) {
      if (times.length >= Math.max(2, entries.length * 0.4)) {
        holdTargets[String(castIdx)] = {
          target_s: round(median(times)),
          stddev_s: round(stdev(times)),
          count: times.length,
          total_samples: entries.length,
        };
      }
    }

    const upmList = entries
      .filter(e => e.fight_duration_s)
      .map(e => e.total_uses / (e.fight_duration_s / 60));
    const blCount = entries.filter(e => e.bl_aligned).length;

    perCdBenchmarks[cdName] = {
      sample_count: entries.length,
      avg_first_cast_s: topFirstCasts.length ? round(mean(topFirstCasts)) : 0,
      stddev_first_cast_s: topFirstCasts.length ? round(stdev(topFirstCasts)) : 0,
      avg_gap_s: allCdGaps.length ? round(mean(allCdGaps)) : null,
      stddev_gap_s: allCdGaps.length ? round(stdev(allCdGaps)) : null,
      avg_bl_offset_s: blOffsets.length ? round(mean(blOffsets)) : null,
      stddev_bl_offset_s: blOffsets.length ? round(stdev(blOffsets)) : null,
      hold_targets: holdTargets,
      uses_per_min: benchUsesPerMin(entries),
      avg_uses: entries.length ? round(mean(entries.map(e => e.total_uses || 0))) : 0,
      avg_uses_per_min: upmList.length ? round(mean(upmList), 2) : 0,
      bl_pct: entries.length ? Math.round(blCount / entries.length * 100) : 0,
      majority_hold: entries.filter(e => e.cast_pattern === 'hold').length > entries.length * 0.5,
    };
  }

  // Duration
  const durations = samples.map(s => (s.cooldown_data || {}).fight_duration_s).filter(Boolean);
  const avgDurationS = durations.length ? round(mean(durations)) : 0;

  // Burst windows
  const allBw = [];
  for (const s of samples) {
    for (const bw of ((s.cooldown_data || {}).burst_windows || [])) allBw.push(bw);
  }
  const burstWindowsClustered = allBw.length ? clusterBurstWindows(allBw, samples.length) : [];

  // Gear
  const gear = aggregateGear(samples);

  // Defensive benchmarks
  const specDefensives = getSpecDefensives(spec);
  const aggDefUses = new Map();
  for (const s of samples) {
    for (const d of ((s.cooldown_data || {}).defensives || [])) {
      if (!aggDefUses.has(d.name)) aggDefUses.set(d.name, []);
      aggDefUses.get(d.name).push(d.uses || 0);
    }
  }

  const topDefensivesSummary = [];
  for (const defn of specDefensives) {
    const uses = aggDefUses.get(defn.name);
    if (!uses || !uses.length) continue;
    topDefensivesSummary.push({
      name: defn.name,
      spell_id: defn.spell_id,
      avg_uses: round(mean(uses)),
      min_uses: Math.min(...uses),
      max_uses: Math.max(...uses),
      sample_count: uses.length,
    });
  }

  const aggDef = new Map();
  for (const s of samples) {
    const cdData = s.cooldown_data || {};
    const fightDur = cdData.fight_duration_s || 0;
    for (const d of (cdData.defensives || [])) {
      if (!aggDef.has(d.name)) aggDef.set(d.name, []);
      aggDef.get(d.name).push({ ...d, fight_duration_s: fightDur });
    }
  }

  const perDefensiveBenchmarks = {};
  for (const [defName, entries] of aggDef.entries()) {
    const topFirstCasts = entries.map(e => e.first_cast_s).filter(v => v != null);
    const allDefGaps = [];
    for (const e of entries) {
      const times = e.cast_times_s || [];
      for (let j = 1; j < times.length; j++) allDefGaps.push(times[j] - times[j - 1]);
    }

    const holdByCastIdx = new Map();
    for (const e of entries) {
      for (const hw of (e.hold_windows || [])) {
        if (!holdByCastIdx.has(hw.cast_index)) holdByCastIdx.set(hw.cast_index, []);
        holdByCastIdx.get(hw.cast_index).push(hw.actual_s);
      }
    }
    const holdTargets = {};
    for (const [castIdx, times] of holdByCastIdx.entries()) {
      if (times.length >= Math.max(2, entries.length * 0.4)) {
        holdTargets[String(castIdx)] = {
          target_s: round(median(times)),
          stddev_s: round(stdev(times)),
          count: times.length,
          total_samples: entries.length,
        };
      }
    }

    const avgUsesList = entries.map(e => e.uses || 0);
    const upmList = entries
      .filter(e => e.fight_duration_s && e.uses)
      .map(e => e.uses / (e.fight_duration_s / 60));

    perDefensiveBenchmarks[defName] = {
      sample_count: entries.length,
      avg_first_cast_s: topFirstCasts.length ? round(mean(topFirstCasts)) : 0,
      stddev_first_cast_s: topFirstCasts.length ? round(stdev(topFirstCasts)) : 0,
      avg_gap_s: allDefGaps.length ? round(mean(allDefGaps)) : null,
      stddev_gap_s: allDefGaps.length ? round(stdev(allDefGaps)) : null,
      hold_targets: holdTargets,
      avg_uses: avgUsesList.length ? round(mean(avgUsesList)) : 0,
      avg_uses_per_min: upmList.length ? round(mean(upmList), 2) : 0,
      uses_per_min: benchUsesPerMin(entries),
      majority_hold: entries.filter(e => e.cast_pattern === 'hold').length > entries.length * 0.5,
    };
  }

  // Defensive windows
  const allDw = [];
  for (const s of samples) {
    for (const dw of ((s.cooldown_data || {}).defensive_windows || [])) allDw.push(dw);
  }
  const defensiveWindowsClustered = allDw.length ? clusterDefensiveWindows(allDw, samples.length) : [];

  // Damage taken comparison
  const aggDtk = new Map();
  for (const s of samples) {
    for (const ab of ((s.cooldown_data || {}).dmg_taken_by_ability || [])) {
      if (!aggDtk.has(ab.spell_id)) aggDtk.set(ab.spell_id, []);
      aggDtk.get(ab.spell_id).push(ab.pct || 0);
    }
  }

  const minParses = Math.max(2, samples.length * 0.4);
  const topDtkComparison = [];
  for (const [sid, pcts] of aggDtk.entries()) {
    if (pcts.length < minParses) continue;
    const avg = mean(pcts);
    const sd = pcts.length > 1 ? round(stdev(pcts), 4) : 0;
    topDtkComparison.push({
      spell_id: sid,
      avg_pct: round(avg, 4),
      min_pct: round(Math.min(...pcts), 4),
      max_pct: round(Math.max(...pcts), 4),
      stddev_pct: sd,
      sample_count: pcts.length,
    });
  }
  topDtkComparison.sort((a, b) => b.avg_pct - a.avg_pct);
  const topDtkComparisonTrimmed = topDtkComparison.slice(0, 12);

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
    top_dtk_comparison: topDtkComparisonTrimmed,
  };

  const encPath = getEncounterPath(spec, encounterId);
  writeJson(encPath, out);
  syncEncountersIndex(spec);
}

function syncEncountersIndex(spec) {
  const encDir = path.join(DATA_DIR, spec, 'encounters');
  if (!fs.existsSync(encDir)) return;
  const entries = [];
  for (const f of fs.readdirSync(encDir).sort()) {
    if (!f.endsWith('.json')) continue;
    try {
      const d = readJson(path.join(encDir, f)) || {};
      entries.push({
        id: d.encounter_id || parseInt(f),
        name: d.encounter_name || f,
        sample_count: d.sample_count || 0,
      });
    } catch {}
  }
  writeJson(path.join(DATA_DIR, spec, 'encounters.json'), entries);
}

/** Rebuild data/specs/index.json by scanning all spec folders on disk. */
function writeSpecIndex() {
  if (!fs.existsSync(DATA_DIR)) return;
  const entries = [];
  for (const spec of fs.readdirSync(DATA_DIR).sort()) {
    const encFile = path.join(DATA_DIR, spec, 'encounters.json');
    if (!fs.existsSync(encFile)) continue;
    try {
      const enc = readJson(encFile) || [];
      const count = enc.filter(e => e.sample_count > 0).length;
      if (count > 0) entries.push({ spec, encounter_count: count });
    } catch {}
  }
  writeJson(path.join(DATA_DIR, 'index.json'), entries);
}

// ── Spec selection ────────────────────────────────────────────────────────────

// Returns known specs (those with a rulebook.json) sorted most-stale-first.
// Staleness = age of the most-overdue encounter for that spec:
//   - No samples at all  -> Infinity (never ingested, always picked first)
//   - At least one sample -> now - newest sampled_at across that encounter's samples
// Using age rather than sample count means anonymous parses (which can never
// fill a full TOP_N slot) and low-population bosses don't cause a spec to
// appear perpetually overdue.
function specsByStaleness(encounters) {
  const now = Date.now();
  const known = getKnownSpecs();
  return known.slice().sort((a, b) => staleness(a, encounters, now) - staleness(b, encounters, now));
}

function staleness(spec, encounters, now) {
  let worst = 0;
  for (const enc of encounters) {
    const samples = readJson(getSamplesPath(spec, enc.id)) || [];
    if (!samples.length) return Infinity; // never ingested
    const newestMs = Math.max(...samples.map(s => new Date(s.sampled_at || 0).getTime()));
    const ageMs = now - newestMs;
    if (ageMs > worst) worst = ageMs;
  }
  return worst;
}

function getKnownSpecs() {
  if (!fs.existsSync(DATA_DIR)) return [];
  return fs.readdirSync(DATA_DIR).filter(d => {
    try {
      if (!fs.statSync(path.join(DATA_DIR, d)).isDirectory()) return false;
      return fs.existsSync(path.join(DATA_DIR, d, 'rulebook.json'));
    } catch { return false; }
  }).sort();
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('warcraft-learner - Parse Ingestion CLI');

  let wcl;
  try {
    wcl = new WCLClient();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  process.stdout.write('Fetching WCL encounters...');
  let encounters;
  try {
    encounters = await getEncounters(wcl);
    console.log(` ${encounters.length} encounters in current expansion`);
  } catch (err) {
    console.error(`\nFailed to fetch encounters: ${err.message}`);
    process.exit(1);
  }

  const specArg = (() => {
    const idx = process.argv.indexOf('--spec');
    return idx !== -1 ? process.argv[idx + 1] : null;
  })();

  let specs;
  if (specArg) {
    if (!SPEC_TO_WCL[specArg]) {
      console.error(`Unknown spec "${specArg}". Known specs: ${Object.keys(SPEC_TO_WCL).join(', ')}`);
      process.exit(1);
    }
    specs = [specArg];
    console.log(`Targeting spec: ${specArg}`);
  } else {
    specs = specsByStaleness(encounters);
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

async function ingestSpecNonInteractive(wcl, spec, encounters) {
  console.log(`\nIngesting ${spec} - ${encounters.length} encounters (top ${TOP_N})`);
  try {
    for (const enc of encounters) {
      // Freshness short-circuit: skip this encounter entirely (0 queries) when we
      // have at least one current-hash sample collected within freshHours. Gating
      // on count > 0 (not >= TOP_N) handles anonymous parses and low-population
      // bosses that can never fill a full TOP_N slot.
      const samplesPath = getSamplesPath(spec, enc.id);
      const existingSamples = readJson(samplesPath) || [];
      if (existingSamples.length > 0) {
        const allFresh = existingSamples.every(s => s.ingest_hash === INGEST_HASH);
        if (allFresh) {
          const newestMs = Math.max(...existingSamples.map(s => new Date(s.sampled_at || 0).getTime()));
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
      let rankings;
      try {
        rankings = await fetchRankingsLite(wcl, spec, enc.id, TOP_N, enc.partitionIds || []);
      } catch (err) {
        if (err instanceof BudgetExceededError) throw err;
        console.log(` FAILED: ${err.message}`);
        continue;
      }
      console.log(` ${rankings.length} rankings found`);

      const currentTopKeys = new Set(rankings.map(r => parseKey(r.report_code, r.fight_id)));

      // Keep cached samples still in the current top N AND produced by this script version.
      const keptSamples = existingSamples.filter(s =>
        currentTopKeys.has(parseKey(s.report_code, s.fight_id, s.ingest_hash))
      );
      const cachedKeys = new Set(keptSamples.map(s => parseKey(s.report_code, s.fight_id)));
      writeJson(samplesPath, keptSamples);

      // Keep positions only for samples that are still valid.
      const posFile = getPositionsPath(spec, enc.id);
      const existingPosData = readJson(posFile) || {};
      const existingPosParses = Array.isArray(existingPosData.parses) ? existingPosData.parses : [];
      const keptPositions = existingPosParses.filter(p => cachedKeys.has(parseKey(p.report_code, p.fight_id)));
      if (keptPositions.length > 0) {
        writeJson(posFile, { ...existingPosData, parses: keptPositions, sample_count: keptPositions.length }, true);
      } else if (fs.existsSync(posFile)) {
        fs.unlinkSync(posFile);
      }

      let done = 0, cached = 0;
      for (const ranking of rankings) {
        const key = parseKey(ranking.report_code, ranking.fight_id);
        if (cachedKeys.has(key)) {
          cached++;
          done++;
          continue;
        }

        // Uncached parse: enrich (server slug + v2 talent) then analyze.
        await wcl.assertBudget(POINTS_MARGIN);
        process.stdout.write(`\r  [${enc.name}] Analyzing ${done + 1}/${rankings.length}: ${ranking.player}...    `);
        try {
          const enriched = await enrichRanking(wcl, ranking, enc.id);
          const combatant_info = enriched.combatant_info;
          const res = await analyzeParse(wcl, spec, ranking.report_code, ranking.fight_id, ranking.player, combatant_info);
          if (res?.cooldown_data) {
            saveParseSample(spec, enc.id, enc.name, ranking.report_code, ranking.fight_id, ranking.player, res.cooldown_data);
            savePositions(spec, enc.id, enc.name, res.positions);
          }
        } catch (err) {
          if (err instanceof BudgetExceededError) throw err;
          process.stdout.write(` (skip: ${err.message.slice(0, 40)})`);
        }
        done++;
      }
      process.stdout.write(`\r  [${enc.name}] ${rankings.length - cached} analyzed, ${cached} cached.          \n`);

      process.stdout.write(`  [${enc.name}] Computing bench data...`);
      syncEncounterFile(spec, enc.id);
      await resolveEnchantNames(wcl, spec, enc.id);
      console.log(' done');
    }
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      console.log(`\n[budget] Stopping cleanly: ${err.message}`);
      console.log('[budget] Partial progress committed; remaining work picked up next run.');
      writeSpecIndex();
      return true;
    }
    throw err;
  }
  writeSpecIndex();
  console.log(`\nIngestion complete for ${spec}.`);
  return false;
}

main().catch(err => {
  console.error('\nFatal error:', err.message);
  process.exit(1);
});
