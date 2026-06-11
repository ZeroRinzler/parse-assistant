// WCL PKCE OAuth2 + GraphQL client - no secrets, browser-safe.

const WCL_CLIENT_ID  = 'a1ff2833-d873-4e41-9965-eea3f622586f';
const WCL_AUTH_URL   = 'https://www.warcraftlogs.com/oauth/authorize';
const WCL_TOKEN_URL  = 'https://www.warcraftlogs.com/oauth/token';
const WCL_API_URL    = 'https://www.warcraftlogs.com/api/v2/user';

const BLOODLUST_SPELL_IDS = new Set([2825, 32182, 80353, 90355, 264667, 390386]);
const BLOODLUST_DURATION_S = 40;

const _WCL_CLASS_NAMES = {
  1:'DeathKnight',2:'Druid',3:'Hunter',4:'Mage',5:'Monk',
  6:'Paladin',7:'Priest',8:'Rogue',9:'Shaman',10:'Warlock',
  11:'Warrior',12:'DemonHunter',13:'Evoker',
};

// ── PKCE helpers ──────────────────────────────────────────────────────────────

function _b64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}
function _generateVerifier() {
  const b = new Uint8Array(32); crypto.getRandomValues(b); return _b64url(b);
}
async function _generateChallenge(v) {
  return _b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v)));
}
function _redirectUri() {
  const base = window.location.origin + window.location.pathname.replace(/\/[^/]+$/, '');
  return `${base}/callback.html`;
}

// ── Token storage ─────────────────────────────────────────────────────────────

function wclGetToken() {
  const tok = localStorage.getItem('wcl_token');
  const exp = parseInt(localStorage.getItem('wcl_token_expiry') || '0', 10);
  return (tok && Date.now() < exp - 60_000) ? tok : null;
}
function wclIsLoggedIn() { return !!wclGetToken(); }
function wclClearToken() {
  localStorage.removeItem('wcl_token');
  localStorage.removeItem('wcl_token_expiry');
  localStorage.removeItem('wcl_user_chars');
}

// ── User characters ───────────────────────────────────────────────────────────

const _USER_CHARS_Q = `{userData{currentUser{characters{id name serverSlug serverRegion}}}}`;

async function wclFetchUserCharacters() {
  const d = await wclQuery(_USER_CHARS_Q);
  const chars = d?.userData?.currentUser?.characters || [];
  try { localStorage.setItem('wcl_user_chars', JSON.stringify(chars)); } catch {}
  return chars;
}

function wclGetCachedUserChars() {
  try { return JSON.parse(localStorage.getItem('wcl_user_chars')) || []; } catch { return []; }
}

// ── Shared auth UI ───────────────────────────────────────────────────────────

function _updateWclUI() {
  const btn    = document.getElementById('wcl-btn');
  const banner = document.getElementById('auth-banner');
  const mainUi = document.getElementById('main-ui');
  const loggedIn = wclIsLoggedIn();
  if (mainUi) mainUi.classList.toggle('hidden', !loggedIn);
  if (banner) banner.classList.toggle('hidden', loggedIn);
  if (loggedIn) {
    btn.textContent = 'WCL ✓';
    btn.classList.add('connected');
  } else {
    btn.textContent = 'Connect WCL';
    btn.classList.remove('connected');
  }
  btn.classList.remove('hidden');
}

function toggleWclAuth() {
  if (wclIsLoggedIn()) {
    if (confirm('Disconnect from Warcraft Logs?')) { wclClearToken(); _updateWclUI(); }
  } else { wclLogin(); }
}

// ── Auth flow ─────────────────────────────────────────────────────────────────

async function wclLogin() {
  const verifier  = _generateVerifier();
  const challenge = await _generateChallenge(verifier);
  sessionStorage.setItem('wcl_code_verifier', verifier);
  sessionStorage.setItem('wcl_return_path', window.location.href);
  const p = new URLSearchParams({
    client_id: WCL_CLIENT_ID, redirect_uri: _redirectUri(),
    response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256',
  });
  window.location.href = `${WCL_AUTH_URL}?${p}`;
}

async function wclExchangeCode(code) {
  const verifier = sessionStorage.getItem('wcl_code_verifier');
  if (!verifier) throw new Error('No code verifier - auth flow was not started in this browser tab');
  const resp = await fetch(WCL_TOKEN_URL, {
    method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams({
      grant_type: 'authorization_code', client_id: WCL_CLIENT_ID,
      code, redirect_uri: _redirectUri(), code_verifier: verifier,
    }),
  });
  if (!resp.ok) throw new Error(`WCL token exchange failed (${resp.status}): ${await resp.text()}`);
  const d = await resp.json();
  localStorage.setItem('wcl_token', d.access_token);
  localStorage.setItem('wcl_token_expiry', String(Date.now() + (d.expires_in || 3600) * 1000));
  sessionStorage.removeItem('wcl_code_verifier');
}

// ── GraphQL ───────────────────────────────────────────────────────────────────

async function wclQuery(gql, variables = {}) {
  const token = wclGetToken();
  if (!token) { wclClearToken(); throw new Error('Not logged in to WCL - click "Connect WCL" to authorize.'); }
  const resp = await fetch(WCL_API_URL, {
    method: 'POST',
    headers: {'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json'},
    body: JSON.stringify({query: gql, variables}),
  });
  if (resp.status === 401) { wclClearToken(); throw new Error('WCL session expired - click "Connect WCL" to log in again.'); }
  if (!resp.ok) throw new Error(`WCL API error (${resp.status})`);
  const body = await resp.json();
  if (body.errors?.length) throw new Error(body.errors[0].message || 'WCL GraphQL error');
  return body.data;
}

// ── Paginated event fetch ─────────────────────────────────────────────────────

const _EVENTS_Q = `
query($code:String!,$fightIDs:[Int]!,$dataType:EventDataType,$sourceID:Int,$targetID:Int,$startTime:Float,$endTime:Float){
  reportData{report(code:$code){
    events(fightIDs:$fightIDs,dataType:$dataType,sourceID:$sourceID,targetID:$targetID,
           startTime:$startTime,endTime:$endTime,limit:10000){data nextPageTimestamp}
  }}
}`;

async function wclGetAllEvents(code, fightId, dataType, startTime, endTime, sourceId, targetId) {
  const events = [];
  let ts = startTime;
  for (;;) {
    const vars = {code, fightIDs:[fightId], dataType, startTime:ts, endTime};
    if (sourceId != null) vars.sourceID = sourceId;
    if (targetId != null) vars.targetID = targetId;
    const data = await wclQuery(_EVENTS_Q, vars);
    const page = data.reportData.report.events;
    events.push(...(page.data || []));
    if (!page.nextPageTimestamp) break;
    ts = page.nextPageTimestamp;
  }
  return events;
}

// ── Report + player helpers ───────────────────────────────────────────────────

const _REPORT_Q = `
query($code:String!){reportData{report(code:$code){
  title
  fights(killType:All){id name startTime endTime kill encounterID difficulty friendlyPlayers}
  masterData{
    actors(type:"Player"){id name subType server}
    abilities{gameID name icon}
  }
}}}`;

const _PD_Q = `
query($code:String!,$fightIDs:[Int]!){
  reportData{report(code:$code){playerDetails(fightIDs:$fightIDs)}}
}`;

async function wclGetReport(code) {
  const d = await wclQuery(_REPORT_Q, {code});
  return d.reportData.report;
}

async function wclGetPlayerDetails(code, fightId) {
  const d = await wclQuery(_PD_Q, {code, fightIDs:[fightId]});
  const raw = d.reportData.report.playerDetails;
  const outer = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const details = outer?.data?.playerDetails ?? outer ?? {};
  const map = {};
  for (const role of ['dps','healers','tanks','unknown']) {
    for (const p of (details[role] || [])) {
      const cls  = (p.type || '').replace(/ /g,'');
      const spec = ((p.specs || [])[0]?.spec || '').replace(/ /g,'');
      if (spec && cls) map[p.id] = spec + cls;
      if (p.name) map[`name_${p.id}`] = p.name;
    }
  }
  return map;
}

// ── Character lookup ──────────────────────────────────────────────────────────

const _CHAR_Q = `
query($name:String!,$serverSlug:String!,$serverRegion:String!){
  characterData{character(name:$name,serverSlug:$serverSlug,serverRegion:$serverRegion){
    name classID
    recentReports(limit:5){data{code startTime}}
  }}
}`;

const _CHAR_ENC_Q = `
query($name:String!,$serverSlug:String!,$serverRegion:String!,$encID:Int!){
  characterData{character(name:$name,serverSlug:$serverSlug,serverRegion:$serverRegion){
    encounterRankings(encounterID:$encID,includeCombatantInfo:true)
  }}
}`;

function _parseCharUrl(url) {
  const m = url.match(/warcraftlogs\.com\/character\/([^/?#]+)\/([^/?#]+)\/([^/?#]+)/i);
  if (m) return {region: m[1].toLowerCase(), server: m[2].toLowerCase(), name: m[3]};
  throw new Error('Not a valid WCL character URL (expected /character/region/server/name)');
}

async function _resolveCharSpec(name, server, region) {
  const d = await wclQuery(_CHAR_Q, {name, serverSlug: server, serverRegion: region});
  const char = d?.characterData?.character;
  if (!char) throw new Error(`Character not found: ${name}-${server} (${region})`);

  let spec = null, sourceReport = null;
  const reports = char.recentReports?.data || [];
  if (!reports.length) throw new Error('No recent WCL reports found for this character.');
  sourceReport = reports[0].code;

  for (const rep of reports.slice(0, 3)) {
    try {
      const rd = await wclGetReport(rep.code);
      const fights = rd.fights || [];
      if (!fights.length) continue;
      const specMap = await wclGetPlayerDetails(rep.code, fights[0].id);
      const actor = (rd.masterData?.actors || []).find(a => a.name.toLowerCase() === char.name.toLowerCase());
      if (actor && specMap[actor.id]) { spec = specMap[actor.id]; sourceReport = rep.code; break; }
    } catch { /* try next report */ }
  }

  return {name: char.name, spec, server, region, source_report: sourceReport};
}

async function wclCharLookupByCoords(name, server, region) {
  return _resolveCharSpec(name, server, region);
}

async function wclCharLookup(url) {
  const {region, server, name} = _parseCharUrl(url);
  return _resolveCharSpec(name, server, region);
}

// Extract combatant info (gear/talents/enchants) from a WCL encounterRankings entry
function _extractCombatantInfo(entry) {
  if (!entry) return {talent_key: '', trinkets: [], enchants: []};
  const gear     = entry.gear || [];
  const talentsR = entry.talents || [];
  const trinkets = [], enchants = [];

  gear.forEach((item, idx) => {
    if (!item?.id) return;
    const id   = typeof item.id === 'string' ? parseInt(item.id, 10) : item.id;
    const name = item.name || '';
    if (idx === 12 || idx === 13) trinkets.push({slot: idx, id, name});
    const enc = item.permanentEnchant;
    if (enc) {
      const eid = typeof enc === 'string' ? parseInt(enc, 10) : enc;
      enchants.push({slot: idx, id: eid, name: item.permanentEnchantName || ''});
    }
  });

  // Talent key extraction - mirrors Python _extract_combatant_info
  let talentKey = '';
  if (typeof talentsR === 'string' && talentsR) {
    talentKey = talentsR;
  } else if (Array.isArray(talentsR) && talentsR.length) {
    // v1 legacy: [{talentID: N, points: P}]
    const ids = talentsR.filter(t => t?.talentID || t?.id).map(t => t.talentID ?? t.id);
    if (ids.length) talentKey = 'v1:' + [...ids].sort().join(',');
  } else if (talentsR && typeof talentsR === 'object') {
    // Midnight v2: {class: {row_N: [{node:{nodeId:N}}, ...]}, spec: {...}}
    const ids = [];
    for (const sectionKey of ['class', 'spec']) {
      const section = talentsR[sectionKey];
      if (!section || typeof section !== 'object') continue;
      for (const rowArr of Object.values(section)) {
        if (!Array.isArray(rowArr)) continue;
        for (const entry of rowArr) {
          const nid = entry?.node?.nodeId ?? entry?.nodeId;
          if (nid != null) ids.push(nid);
        }
      }
    }
    if (ids.length) talentKey = 'v2:' + [...new Set(ids)].sort((a,b)=>a-b).join(',');
  }

  return {talent_key: talentKey, trinkets, enchants};
}

async function wclGetCharGear(name, server, region, encounterId) {
  const d = await wclQuery(_CHAR_ENC_Q, {
    name, serverSlug: server, serverRegion: region, encID: encounterId,
  });
  const raw = d?.characterData?.character?.encounterRankings;
  if (raw == null) throw new Error(`Character not found: ${name}-${server} (${region})`);
  const rankData = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const ranks    = (rankData?.ranks || []);
  if (!ranks.length) return {found: false, message: 'No ranked kills found for this encounter.'};

  const mostRecent = ranks.reduce((best, r) => (r.startTime || 0) > (best.startTime || 0) ? r : best);
  const gear       = _extractCombatantInfo(mostRecent);

  const specPart  = mostRecent.spec || '';
  const classId   = mostRecent.class;
  const className = _WCL_CLASS_NAMES[classId] || '';
  const fullSpec  = specPart && className ? specPart + className : specPart;

  // Resolve enchant names via gameData.enchant aliases
  const enchantIds = [...new Set(gear.enchants.filter(e => e.id).map(e => e.id))];
  if (enchantIds.length) {
    try {
      const parts  = enchantIds.map(id => `e${id}: enchant(id:${id}){id name}`).join(' ');
      const encGql = `query{gameData{${parts}}}`;
      const encD   = await wclQuery(encGql);
      const gd     = encD?.gameData || {};
      for (const e of gear.enchants) {
        if (!e.name && e.id) e.name = gd[`e${e.id}`]?.name || '';
      }
    } catch { /* enchant names are non-critical */ }
  }

  return {
    found: true, spec: fullSpec,
    source_report: (mostRecent.report?.code || null),
    ...gear,
  };
}
