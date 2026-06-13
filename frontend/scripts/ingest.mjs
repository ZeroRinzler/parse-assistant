#!/usr/bin/env node
/**
 * warcraft-learner — Standalone Parse Ingestion CLI
 *
 * Fetches top WCL parses for a spec+encounter and writes:
 *   data/specs/{spec}/parse_samples/{enc_id}.json  — raw samples
 *   data/specs/{spec}/encounters/{enc_id}.json      — aggregated bench data
 *   data/specs/{spec}/encounters.json               — encounter index
 *
 * Usage:
 *   npm run ingest
 *
 * Requires: WCL_CLIENT_ID and WCL_CLIENT_SECRET in .env at the repo root.
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

// ── Paths ─────────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FRONTEND_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(FRONTEND_ROOT, 'public', 'data', 'specs');

// ── Env loading ───────────────────────────────────────────────────────────────

function loadEnv() {
  const envPath = path.join(FRONTEND_ROOT, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = val;
  }
}

loadEnv();

// ── Constants ─────────────────────────────────────────────────────────────────

const WCL_TOKEN_URL = 'https://www.warcraftlogs.com/oauth/token';
const WCL_API_URL = 'https://www.warcraftlogs.com/api/v2/client';

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

// ── Readline helpers ──────────────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(prompt) {
  return new Promise(resolve => rl.question(prompt, resolve));
}

async function askList(prompt, choices) {
  const lines = choices.map((c, i) => `  [${i + 1}] ${c}`).join('\n');
  while (true) {
    const ans = await ask(`${prompt}\n${lines}\n> `);
    const n = parseInt(ans);
    if (n >= 1 && n <= choices.length) return n - 1;
    console.log('Invalid choice, try again.');
  }
}

// ── WCL OAuth2 client ─────────────────────────────────────────────────────────

class WCLClient {
  constructor() {
    this.clientId = process.env.WCL_CLIENT_ID || '';
    this.clientSecret = process.env.WCL_CLIENT_SECRET || '';
    if (!this.clientId || !this.clientSecret) {
      throw new Error('WCL_CLIENT_ID and WCL_CLIENT_SECRET must be set in .env');
    }
    this._token = null;
    this._tokenExpiry = 0;
    this._serverSlugCache = new Map();
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
      throw new Error(`WCL API error ${res.status}: ${text.slice(0, 300)}`);
    }
    const body = await res.json();
    if (body.errors) {
      throw new Error(`GraphQL error: ${JSON.stringify(body.errors)}`);
    }
    return body.data;
  }

  async getAllEvents(code, fightId, dataType, startTime, endTime, options = {}) {
    const EVENTS_QUERY = `
      query GetEvents(
        $code: String! $fightIDs: [Int]! $dataType: EventDataType
        $sourceID: Int $targetID: Int $startTime: Float $endTime: Float
      ) {
        reportData { report(code: $code) {
          events(fightIDs: $fightIDs dataType: $dataType sourceID: $sourceID
                 targetID: $targetID startTime: $startTime endTime: $endTime limit: 10000) {
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
        encounters { id name }
      }
    }
  }
}`;

const RANKINGS_QUERY = `
query($encounterID: Int!, $className: String!, $specName: String!) {
  worldData {
    encounter(id: $encounterID) {
      name
      characterRankings(className: $className specName: $specName metric: dps includeCombatantInfo: true)
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
    for (const enc of (zone.encounters || [])) {
      result.push({ id: enc.id, name: enc.name, zone: zone.name, expansion: firstExp.name });
    }
  }
  return result;
}

// ── Talent extraction ─────────────────────────────────────────────────────────

const TRINKET_INDICES = new Set([12, 13]);

function extractCombatantInfo(rankingEntry) {
  if (!rankingEntry) return { talent_key: '', trinkets: [], enchants: [] };

  const gear = rankingEntry.gear || [];
  const talentsRaw = rankingEntry.talents;

  const trinkets = [];
  const enchants = [];
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
  }

  let talentKey = '';
  if (typeof talentsRaw === 'string') {
    talentKey = talentsRaw;
  } else if (Array.isArray(talentsRaw) && talentsRaw.length > 0) {
    // Old WCL format: [{talentID: N, points: P}]
    const ids = talentsRaw
      .filter(t => t)
      .map(t => String(t.talentID || t.id || ''))
      .filter(x => x)
      .sort();
    talentKey = 'v1:' + ids.join(',');
  } else if (talentsRaw && typeof talentsRaw === 'object') {
    // Midnight format: {class: {row: [{node: {nodeId: N}}]}, spec: {...}}
    const nodeIds = [];
    for (const sectionKey of ['class', 'spec']) {
      const section = talentsRaw[sectionKey] || {};
      if (typeof section === 'object') {
        for (const rowNodes of Object.values(section)) {
          if (Array.isArray(rowNodes)) {
            for (const entry of rowNodes) {
              const nid = (entry.node || {}).nodeId;
              if (nid) nodeIds.push(String(nid));
            }
          }
        }
      }
    }
    talentKey = 'v2:' + nodeIds.sort().join(',');
  }

  return { talent_key: talentKey, trinkets, enchants };
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
    return extractCombatantInfo(mostRecent).talent_key || '';
  } catch {
    return '';
  }
}

// ── Rankings fetching ─────────────────────────────────────────────────────────

async function fetchTopRankings(wcl, spec, encounterId, count = 10) {
  const mapping = SPEC_TO_WCL[spec];
  if (!mapping) throw new Error(`Unknown spec: ${spec}`);
  const [className, specName] = mapping;

  const data = await wcl.query(RANKINGS_QUERY, { encounterID: encounterId, className, specName });
  const enc = data.worldData.encounter;
  let raw = enc.characterRankings;
  const rankingsData = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const rankings = (rankingsData.rankings || []).slice(0, count);

  // Resolve server slugs for all unique server IDs
  const uniqueSids = [...new Set(rankings.map(r => (r.server || {}).id).filter(Boolean))];
  const slugPairs = await Promise.all(uniqueSids.map(sid => wcl.resolveServerSlug(sid)));
  const sidToSlugs = new Map(uniqueSids.map((sid, i) => [sid, slugPairs[i]]));

  function slugsFor(r) {
    const sid = (r.server || {}).id;
    return sidToSlugs.get(sid) || ['', ''];
  }

  // Fetch v2 talent keys in parallel
  const talentKeys = await Promise.all(
    rankings.map(r => {
      const [serverSlug, serverRegion] = slugsFor(r);
      return fetchV2Talent(wcl, r.name || '', serverSlug, serverRegion, encounterId);
    })
  );

  return rankings.map((r, i) => {
    const ci = { ...r };
    if (talentKeys[i]) ci.talents = talentKeys[i];
    const [serverSlug, serverRegion] = slugsFor(r);
    return {
      rank: i + 1,
      player: r.name,
      amount: Math.round(r.amount || 0),
      duration_s: Math.round((r.duration || 0) / 100) / 10,
      report_code: (r.report || {}).code,
      fight_id: (r.report || {}).fightID,
      server: (r.server || {}).name,
      server_slug: serverSlug,
      server_region: serverRegion,
      combatant_info: ci,
    };
  });
}

// ── Burst window analysis ─────────────────────────────────────────────────────

function findSignificantWindows(hitsTs, hitsDmg, hitsAids, fightStartMs, total, windowMs, minPctThreshold) {
  const n = hitsTs.length;
  let j = 0;
  let windowSum = 0;
  const candidates = [];

  for (let i = 0; i < n; i++) {
    while (j < n && hitsTs[j] <= hitsTs[i] + windowMs) {
      windowSum += hitsDmg[j];
      j++;
    }
    candidates.push([hitsTs[i], windowSum]);
    windowSum -= hitsDmg[i];
  }

  const minDmg = total * minPctThreshold;
  candidates.sort((a, b) => b[1] - a[1]);

  const selected = [];
  for (const [ts, dmg] of candidates) {
    if (dmg < minDmg) break;
    if (selected.some(s => Math.abs(ts - (fightStartMs + s.time_s * 1000)) < windowMs)) continue;
    const tEnd = ts + windowMs;
    const abilityDmg = new Map();
    for (let k = 0; k < n; k++) {
      if (hitsTs[k] < ts || hitsTs[k] > tEnd) continue;
      if (hitsAids[k]) {
        abilityDmg.set(hitsAids[k], (abilityDmg.get(hitsAids[k]) || 0) + hitsDmg[k]);
      }
    }
    const topAbilities = [...abilityDmg.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([sid, d]) => ({ spell_id: sid, damage: d, pct: dmg ? Math.round(d / dmg * 1000) / 1000 : 0 }));

    selected.push({
      time_s: Math.round((ts - fightStartMs) / 100) / 10,
      pct_of_total: Math.round(dmg / total * 1000) / 1000,
      window_damage: dmg,
      total_damage: total,
      ability_breakdown: topAbilities,
    });
  }
  return selected.sort((a, b) => a.time_s - b.time_s);
}

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

  // Fall back to 8s sliding window when no CD duration info is available
  if (!rawWins.length) {
    const fallback = findSignificantWindows(
      hits.map(h => h[0]), hits.map(h => h[1]), hits.map(h => h[3]),
      fightStartMs, total, 8000, minPctThreshold,
    );
    for (const w of fallback) { w.active_cds = []; w.target_count = 1; w.window_length_s = 8; }
    return fallback;
  }

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

function findDefensiveWindows(damageTakenEvents, fightStartMs, buffWindows, specDefensives) {
  const hits = damageTakenEvents
    .filter(e => e.type === 'damage' && (e.amount || 0) + (e.absorbed || 0) > 0)
    .map(e => [e.timestamp, (e.amount || 0) + (e.absorbed || 0), e.abilityGameID || 0])
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
        window_length_s: round(mean(cl.map(c => c.window_length_s || 5))),
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

async function analyzeParse(wcl, spec, reportCode, fightId, playerName, combatantInfo) {
  const specCds = getSpecCooldowns(spec) || [];
  const specDefensives = getSpecDefensives(spec);

  let meta;
  try {
    const REPORT_META_Q = `
      query($code: String!) {
        reportData { report(code: $code) {
          fights(killType: Kills) { id startTime endTime encounterID }
          masterData { actors(type: "Player") { id name subType } }
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
  let player = playerName ? actors.find(a => a.name === playerName) : null;
  if (!player) player = actors.find(a => a.subType === spec);
  if (!player) return null;

  const start = fight.startTime;
  const end = fight.endTime;
  const fightDurS = (end - start) / 1000;

  // Fetch all event types in parallel
  let castEvents, buffEvents, damageEvents, damageTakenEvents;
  try {
    [castEvents, buffEvents, damageEvents, damageTakenEvents] = await Promise.all([
      wcl.getAllEvents(reportCode, fightId, 'Casts',       start, end, { sourceId: player.id }),
      wcl.getAllEvents(reportCode, fightId, 'Buffs',       start, end, { targetId: player.id }),
      wcl.getAllEvents(reportCode, fightId, 'DamageDone',  start, end, { sourceId: player.id }),
      wcl.getAllEvents(reportCode, fightId, 'DamageTaken', start, end, { sourceId: player.id }),
    ]);
  } catch {
    return null;
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

  // Burst windows — sized by CD durations, active_cds set inside
  const burstWindows = findBurstWindows(damageEvents, start, cdSummary, specCds);

  // Gear data from combatant info
  const gearData = combatantInfo ? extractCombatantInfo(combatantInfo) : {};

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

  const defensiveWindows = findDefensiveWindows(damageTakenEvents, start, buffWindows, specDefensives);

  // Damage taken analysis
  const segmentS = 30;
  const nSegments = Math.max(1, Math.floor(fightDurS / segmentS) + 1);
  const dmgSegments = new Array(nSegments).fill(0);
  const abilityDmgTaken = new Map();

  for (const e of damageTakenEvents) {
    if (e.type !== 'damage') continue;
    const amt = (e.amount || 0) + (e.absorbed || 0);
    if (!amt) continue;
    const tS = (e.timestamp - start) / 1000;
    const seg = Math.min(Math.floor(tS / segmentS), nSegments - 1);
    dmgSegments[seg] += amt;
    const sid = e.abilityGameID;
    if (sid) abilityDmgTaken.set(sid, (abilityDmgTaken.get(sid) || 0) + amt);
  }

  const totalDmgTaken = dmgSegments.reduce((s, v) => s + v, 0);
  const topDmgAbilities = [...abilityDmgTaken.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([sid, dmg]) => ({
      spell_id: sid,
      damage: dmg,
      pct: totalDmgTaken ? Math.round(dmg / totalDmgTaken * 1000) / 1000 : 0,
    }));

  return {
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
    dmg_taken_segments: dmgSegments,
    dmg_taken_by_ability: topDmgAbilities,
    total_dmg_taken: totalDmgTaken,
    talent_key: gearData.talent_key || '',
    trinkets: gearData.trinkets || [],
    enchants: gearData.enchants || [],
  };
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

// Common statistics for a cluster of windows (time, pct, ability breakdown).
function clusterBaseStats(cl, totalSamples) {
  const times = cl.map(c => c.time_s);
  const pcts  = cl.map(c => c.pct_of_total);
  const sorted = [...pcts].sort((a, b) => a - b);

  const abilityTotals = new Map();
  for (const c of cl) {
    for (const ab of (c.ability_breakdown || [])) {
      if (!abilityTotals.has(ab.spell_id)) abilityTotals.set(ab.spell_id, []);
      abilityTotals.get(ab.spell_id).push(ab.pct);
    }
  }
  const ability_breakdown = [...abilityTotals.entries()]
    .filter(([, ps]) => ps.length >= cl.length * 0.5)
    .map(([sid, ps]) => ({
      spell_id: sid,
      avg_pct: round(mean(ps), 3),
      min_pct: round(Math.min(...ps), 3),
      max_pct: round(Math.max(...ps), 3),
      count: ps.length,
    }))
    .sort((a, b) => b.avg_pct - a.avg_pct)
    .slice(0, 6);

  return {
    time_s: round(median(times)),
    stddev_s: round(stdev(times)),
    count: cl.length,
    total_samples: totalSamples,
    pct_avg: round(mean(pcts), 3),
    pct_stddev: round(stdev(pcts), 3),
    pct_min: round(sorted[0], 3),
    pct_max: round(sorted[sorted.length - 1], 3),
    ability_breakdown,
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
    const window_length_s = round(mean(cl.map(c => c.window_length_s || 8)));
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

  return { sample_count: total, talent_builds: talentBuilds, trinkets, enchants };
}

// ── File I/O ──────────────────────────────────────────────────────────────────

function nowUtc() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return null; }
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function getSamplesPath(spec, encounterId) {
  return path.join(DATA_DIR, spec, 'parse_samples', `${encounterId}.json`);
}

function getEncounterPath(spec, encounterId) {
  return path.join(DATA_DIR, spec, 'encounters', `${encounterId}.json`);
}

function saveParseSample(spec, encounterId, encounterName, reportCode, fightId, playerName, cooldownData) {
  const samplesPath = getSamplesPath(spec, encounterId);
  let samples = readJson(samplesPath) || [];
  // Remove duplicate
  samples = samples.filter(s => !(s.report_code === reportCode && s.fight_id === fightId));
  samples.push({
    spec, encounter_id: encounterId, encounter_name: encounterName,
    report_code: reportCode, fight_id: fightId, player_name: playerName,
    sampled_at: nowUtc(), cooldown_data: cooldownData,
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
  const topAvgEfficiency = effVals.length ? round(mean(effVals)) : null;
  const topEfficiencyStddev = effVals.length > 1 ? round(stdev(effVals)) : null;

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
          stddev_s: round(times.length > 1 ? stdev(times) : 20.0),
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
      avg_first_cast_s: topFirstCasts.length ? round(mean(topFirstCasts)) : null,
      stddev_first_cast_s: topFirstCasts.length > 1 ? round(stdev(topFirstCasts)) : null,
      avg_gap_s: allCdGaps.length ? round(mean(allCdGaps)) : null,
      stddev_gap_s: allCdGaps.length > 1 ? round(stdev(allCdGaps)) : null,
      avg_bl_offset_s: blOffsets.length ? round(mean(blOffsets)) : null,
      stddev_bl_offset_s: blOffsets.length > 1 ? round(stdev(blOffsets)) : null,
      hold_targets: holdTargets,
      uses_per_min: benchUsesPerMin(entries),
      avg_uses: entries.length ? round(mean(entries.map(e => e.total_uses || 0))) : 0,
      avg_uses_per_min: upmList.length ? round(mean(upmList), 2) : null,
      bl_pct: entries.length ? Math.round(blCount / entries.length * 100) : 0,
      majority_hold: entries.filter(e => e.cast_pattern === 'hold').length > entries.length * 0.5,
    };
  }

  // Duration
  const durations = samples.map(s => (s.cooldown_data || {}).fight_duration_s).filter(Boolean);
  const avgDurationS = durations.length ? round(mean(durations)) : null;

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
          stddev_s: round(times.length > 1 ? stdev(times) : 20.0),
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
      avg_first_cast_s: topFirstCasts.length ? round(mean(topFirstCasts)) : null,
      stddev_first_cast_s: topFirstCasts.length > 1 ? round(stdev(topFirstCasts)) : null,
      avg_gap_s: allDefGaps.length ? round(mean(allDefGaps)) : null,
      stddev_gap_s: allDefGaps.length > 1 ? round(stdev(allDefGaps)) : null,
      hold_targets: holdTargets,
      avg_uses: avgUsesList.length ? round(mean(avgUsesList)) : 0,
      avg_uses_per_min: upmList.length ? round(mean(upmList), 2) : null,
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

  // Per-segment damage taken comparison
  const segPctLists = [];
  for (const s of samples) {
    const cd = s.cooldown_data || {};
    const segs = cd.dmg_taken_segments || [];
    const total = cd.total_dmg_taken || segs.reduce((a, b) => a + b, 0) || 0;
    if (total > 0) segPctLists.push(segs.map(seg => seg / total));
  }

  const topDtkSegments = [];
  if (segPctLists.length) {
    const maxSegs = Math.max(...segPctLists.map(s => s.length));
    for (let i = 0; i < maxSegs; i++) {
      const vals = segPctLists.filter(s => i < s.length).map(s => s[i]);
      if (!vals.length) continue;
      topDtkSegments.push({
        seg_index: i,
        avg_pct: round(mean(vals), 4),
        stddev_pct: vals.length > 1 ? round(stdev(vals), 4) : 0,
        sample_count: vals.length,
      });
    }
  }

  const out = {
    spec, encounter_id: encounterId, encounter_name: encName,
    sample_count: samples.length,
    avg_duration_s: avgDurationS,
    last_ingested: nowUtc(),
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
    top_dtk_segments: topDtkSegments,
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

// ── Spec selection ────────────────────────────────────────────────────────────

function getKnownSpecs() {
  if (!fs.existsSync(DATA_DIR)) return [];
  return fs.readdirSync(DATA_DIR).filter(d => {
    try { return fs.statSync(path.join(DATA_DIR, d)).isDirectory(); } catch { return false; }
  }).sort();
}

async function pickSpec() {
  const specs = getKnownSpecs();
  const allSpecs = Object.keys(SPEC_TO_WCL).sort();
  console.log('\nKnown specs in data/specs/:');
  if (specs.length) specs.forEach((s, i) => console.log(`  [${i + 1}] ${s}`));
  else console.log('  (none yet)');
  const raw = await ask('\nEnter spec name or number from list: ');
  const n = parseInt(raw);
  if (n >= 1 && n <= specs.length) return specs[n - 1];
  const trimmed = raw.trim();
  if (SPEC_TO_WCL[trimmed]) return trimmed;
  console.log(`Warning: "${trimmed}" is not in SPEC_TO_WCL — WCL rankings may fail.`);
  return trimmed;
}

// ── Main ingestion flow ───────────────────────────────────────────────────────

async function ingestSpec(wcl, spec, encounters) {
  console.log(`\nIngesting ${spec} — ${encounters.length} encounter(s) available`);

  const allEncs = encounters;
  if (!allEncs.length) {
    console.log('No encounters found for current expansion.');
    return;
  }

  // Show encounter list with existing sample counts
  const existingSamples = new Map();
  for (const enc of allEncs) {
    const samplesPath = getSamplesPath(spec, enc.id);
    const existing = readJson(samplesPath) || [];
    existingSamples.set(enc.id, existing.length);
  }

  console.log(`\nEncounters (${allEncs.length} total):`);
  allEncs.forEach((enc, i) => {
    const count = existingSamples.get(enc.id) || 0;
    console.log(`  [${i + 1}] ${enc.name} — ${count} samples`);
  });

  const choice = await ask('\nEnter encounter number(s) to ingest (comma-separated), "all", or "back": ');
  if (choice.trim().toLowerCase() === 'back') return;

  let selectedEncs;
  if (choice.trim().toLowerCase() === 'all') {
    selectedEncs = allEncs;
  } else {
    const nums = choice.split(',').map(s => parseInt(s.trim())).filter(n => n >= 1 && n <= allEncs.length);
    if (!nums.length) { console.log('No valid selection.'); return; }
    selectedEncs = nums.map(n => allEncs[n - 1]);
  }

  for (const enc of selectedEncs) {
    process.stdout.write(`\n[${enc.name}] Fetching top 10 rankings...`);
    let rankings;
    try {
      rankings = await fetchTopRankings(wcl, spec, enc.id, 10);
    } catch (err) {
      console.log(` FAILED: ${err.message}`);
      continue;
    }
    console.log(` ${rankings.length} rankings found`);

    // Clear existing samples for this encounter
    const samplesPath = getSamplesPath(spec, enc.id);
    if (fs.existsSync(samplesPath)) fs.unlinkSync(samplesPath);

    let done = 0;
    for (const ranking of rankings) {
      process.stdout.write(`\r  [${enc.name}] Analyzing ${done + 1}/${rankings.length}: ${ranking.player}...    `);
      try {
        const cooldownData = await analyzeParse(
          wcl, spec,
          ranking.report_code, ranking.fight_id,
          ranking.player, ranking.combatant_info,
        );
        if (cooldownData) {
          saveParseSample(spec, enc.id, enc.name, ranking.report_code, ranking.fight_id, ranking.player, cooldownData);
        }
      } catch (err) {
        // Log but continue
        process.stdout.write(` (skip: ${err.message.slice(0, 40)})`);
      }
      done++;
    }
    process.stdout.write(`\r  [${enc.name}] ${done}/${rankings.length} parses analyzed.          \n`);

    // Compute bench data
    process.stdout.write(`  [${enc.name}] Computing bench data...`);
    syncEncounterFile(spec, enc.id);
    console.log(' done');
  }
  console.log(`\nIngestion complete for ${spec}.`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('warcraft-learner — Parse Ingestion CLI');

  // ── CLI mode (non-interactive) ──────────────────────────────────────────────
  const argv = process.argv.slice(2);
  const cliSpec = argv.find((_, i) => argv[i - 1] === '--spec');
  const cliAll = argv.includes('--all');
  const cliTopN = parseInt(argv.find((_, i) => argv[i - 1] === '--top-n') || '10', 10) || 10;

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

  if (cliSpec || cliAll) {
    const specs = cliAll ? getKnownSpecs() : [cliSpec];
    if (!specs.length) {
      console.error('No specs found in data directory. Run with --spec SpecName to specify one.');
      process.exit(1);
    }
    for (const spec of specs) {
      await ingestSpecNonInteractive(wcl, spec, encounters, cliTopN);
    }
    rl.close();
    return;
  }

  // ── Interactive mode ────────────────────────────────────────────────────────
  while (true) {
    const spec = await pickSpec();
    if (!spec) break;

    await ingestSpec(wcl, spec, encounters);

    const again = await ask('\nIngest another spec? [y/N] ');
    if (again.trim().toLowerCase() !== 'y') break;
  }

  rl.close();
}

async function ingestSpecNonInteractive(wcl, spec, encounters, topN = 10) {
  console.log(`\nIngesting ${spec} — all ${encounters.length} encounters (top ${topN})`);
  for (const enc of encounters) {
    process.stdout.write(`\n[${enc.name}] Fetching top ${topN} rankings...`);
    let rankings;
    try {
      rankings = await fetchTopRankings(wcl, spec, enc.id, topN);
    } catch (err) {
      console.log(` FAILED: ${err.message}`);
      continue;
    }
    console.log(` ${rankings.length} rankings found`);

    const samplesPath = getSamplesPath(spec, enc.id);
    if (fs.existsSync(samplesPath)) fs.unlinkSync(samplesPath);

    let done = 0;
    for (const ranking of rankings) {
      process.stdout.write(`\r  [${enc.name}] Analyzing ${done + 1}/${rankings.length}: ${ranking.player}...    `);
      try {
        const cooldownData = await analyzeParse(
          wcl, spec, ranking.report_code, ranking.fight_id, ranking.player, ranking.combatant_info,
        );
        if (cooldownData) {
          saveParseSample(spec, enc.id, enc.name, ranking.report_code, ranking.fight_id, ranking.player, cooldownData);
        }
      } catch (err) {
        process.stdout.write(` (skip: ${err.message.slice(0, 40)})`);
      }
      done++;
    }
    process.stdout.write(`\r  [${enc.name}] ${done}/${rankings.length} parses analyzed.          \n`);

    process.stdout.write(`  [${enc.name}] Computing bench data...`);
    syncEncounterFile(spec, enc.id);
    console.log(' done');
  }
  console.log(`\nIngestion complete for ${spec}.`);
}

main().catch(err => {
  console.error('\nFatal error:', err.message);
  process.exit(1);
});
