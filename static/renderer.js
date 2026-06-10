// Shared rendering — used by index.html (post-raid) and live.html (live)

// ── Formatters ─────────────────────────────────────────────────────────────────

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatMs(ms) { return formatDuration(ms / 1000); }

function formatNumber(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

function formatSpec(spec) {
  return spec.replace(/([A-Z])/g, ' $1').trim();
}

function extractCode(url) {
  const m = url.match(/\/reports\/([a-zA-Z0-9]+)/);
  return m ? m[1] : url.trim();
}

// ── Fight / player selectors ──────────────────────────────────────────────────

function populateFights(fights, autoFight = null) {
  const sel = document.getElementById('fight-select');
  sel.innerHTML = '';
  fights.forEach(f => {
    const opt = document.createElement('option');
    opt.value = f.id;
    const status = f.kill ? '✓' : `✗ #${f.attempt}`;
    opt.textContent = `${f.name} [${status}] ${formatDuration(f.duration_s)}`;
    sel.appendChild(opt);
  });
  sel.value = autoFight ?? (fights.length ? fights[fights.length - 1].id : '');
}

function filterAndPopulatePlayers(autoPlayer = null) {
  const fightId = parseInt(document.getElementById('fight-select').value, 10);
  const fight = _allFights.find(f => f.id === fightId);
  const fp = fight?.friendlyPlayers;
  const visible = (fp && fp.length > 0)
    ? _allPlayers.filter(p => fp.includes(p.id))
    : _allPlayers;
  const sel = document.getElementById('player-select');
  const prev = sel.value;
  sel.innerHTML = '';
  visible.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = `${p.name} — ${formatSpec(p.spec)}`;
    sel.appendChild(opt);
  });
  if (autoPlayer) sel.value = autoPlayer;
  else if (prev && visible.some(p => String(p.id) === prev)) sel.value = prev;
}

// ── Error display ─────────────────────────────────────────────────────────────

function showError(msg) {
  const el = document.getElementById('error-box');
  el.textContent = `⚠ ${msg}`;
  el.classList.remove('hidden');
}

function clearError() {
  document.getElementById('error-box').classList.add('hidden');
}

// ── Spell icon cache & rendering ──────────────────────────────────────────────

const _iconCache = {};  // {spell_id: {icon, name}}

async function fetchSpellIcons(spellIds) {
  const missing = spellIds.filter(id => id && !_iconCache[id]);
  if (!missing.length) return;
  try {
    const resp = await fetch(`/api/spell-icons?ids=${missing.join(',')}`);
    if (resp.ok) {
      const data = await resp.json();
      Object.assign(_iconCache, data);  // keys are string spell IDs
    }
  } catch { /* icons are non-critical */ }
}

function spellIconHtml(spellId, size = 'small') {
  const info = _iconCache[spellId] || _iconCache[String(spellId)];
  if (!info?.icon) return '';
  return `<img class="spell-icon spell-icon-${size}" src="https://wow.zamimg.com/images/wow/icons/${size}/${info.icon}.jpg" alt="${info.name || ''}" loading="lazy" onerror="this.style.display='none'" />`;
}

function spellName(spellId) {
  const info = _iconCache[spellId] || _iconCache[String(spellId)];
  return info?.name || '';
}

// ── Category icons ────────────────────────────────────────────────────────────
// Each finding category gets a distinct SVG icon for fast visual scanning.

const _CATEGORY_ICONS = {
  lost_cooldown: `<svg class="cat-icon cat-critical" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="5" y1="5" x2="11" y2="11" stroke="currentColor" stroke-width="1.5"/><line x1="11" y1="5" x2="5" y2="11" stroke="currentColor" stroke-width="1.5"/></svg>`,
  cooldown_delay: `<svg class="cat-icon cat-warning" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="8" y1="4" x2="8" y2="8.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="8" y1="8.5" x2="11" y2="10.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
  cooldown_alignment: `<svg class="cat-icon cat-critical" viewBox="0 0 16 16"><path d="M8 1 L15 13 H1 Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><line x1="8" y1="6" x2="8" y2="9.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="8" cy="11.5" r="0.8" fill="currentColor"/></svg>`,
  cast_efficiency: `<svg class="cat-icon cat-warning" viewBox="0 0 16 16"><path d="M3 13 L8 3 L13 13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><line x1="5" y1="9.5" x2="11" y2="9.5" stroke="currentColor" stroke-width="1.5"/></svg>`,
  rule_violation: `<svg class="cat-icon cat-warning" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="8" y1="5" x2="8" y2="9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="8" cy="11" r="0.8" fill="currentColor"/></svg>`,
  hold_suggestion: `<svg class="cat-icon cat-info" viewBox="0 0 16 16"><circle cx="8" cy="6" r="4" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="8" y1="10" x2="8" y2="13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="6" y1="13" x2="10" y2="13" stroke="currentColor" stroke-width="1.2"/></svg>`,
  success: `<svg class="cat-icon cat-success" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.5"/><polyline points="5,8 7,10.5 11,6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  unsupported_spec: `<svg class="cat-icon cat-info" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="8" y1="7" x2="8" y2="11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="8" cy="5" r="0.8" fill="currentColor"/></svg>`,
};

function categoryIconHtml(category) {
  return _CATEGORY_ICONS[category] || '';
}

// ── Saved character (localStorage) ───────────────────────────────────────────
// Stores {name} so the right player is auto-selected when loading reports.

const CHAR_STORAGE_KEY = 'wcl_saved_char';

function getSavedChar() {
  try { return JSON.parse(localStorage.getItem(CHAR_STORAGE_KEY)) || null; } catch { return null; }
}

function saveChar(name) {
  if (name) localStorage.setItem(CHAR_STORAGE_KEY, JSON.stringify({name: name.trim()}));
}

function clearSavedChar() {
  localStorage.removeItem(CHAR_STORAGE_KEY);
}

// Try to auto-select the saved character in the player dropdown.
// Returns true if found, false if character is not in the current log.
function autoSelectSavedPlayer() {
  const char = getSavedChar();
  if (!char?.name) return null;
  const sel = document.getElementById('player-select');
  if (!sel) return null;
  const nameLower = char.name.toLowerCase();
  for (const opt of sel.options) {
    if (opt.textContent.split(' — ')[0].toLowerCase() === nameLower) {
      sel.value = opt.value;
      return true;
    }
  }
  return false;
}

// Render or update the character chip in the nav bar.
function renderCharChip() {
  const char = getSavedChar();
  const chip = document.getElementById('char-chip');
  if (!chip) return;
  if (char?.name) {
    chip.innerHTML = `<span class="char-chip-name">${char.name}</span><button class="char-chip-change" onclick="promptChangeChar()" title="Change character">✕</button>`;
    chip.classList.add('saved');
  } else {
    chip.innerHTML = `<button class="char-chip-set" onclick="promptChangeChar()">Set my character</button>`;
    chip.classList.remove('saved');
  }
}

function promptChangeChar() {
  const modal = document.getElementById('char-modal');
  if (!modal) return;
  const inp = document.getElementById('char-modal-input');
  if (inp) inp.value = getSavedChar()?.name || '';
  modal.classList.remove('hidden');
  inp?.focus();
}

function closeCharModal(save) {
  const modal = document.getElementById('char-modal');
  if (!modal) return;
  if (save) {
    const name = document.getElementById('char-modal-input')?.value?.trim();
    if (name) {
      saveChar(name);
      renderCharChip();
      // Re-apply selection to current player list
      const found = autoSelectSavedPlayer();
      _updateCharWarning(found);
      if (found !== false && typeof analyzePlayer === 'function') analyzePlayer();
    } else {
      clearSavedChar();
      renderCharChip();
    }
  }
  modal.classList.add('hidden');
}

function _updateCharWarning(found) {
  const warn = document.getElementById('char-not-found');
  if (!warn) return;
  const char = getSavedChar();
  if (found === false && char?.name) {
    warn.textContent = `⚠ ${char.name} not found in this log — select a player below.`;
    warn.classList.remove('hidden');
    document.getElementById('player-select')?.parentElement?.classList?.remove('hidden');
  } else {
    warn.classList.add('hidden');
    if (char?.name) document.getElementById('player-select')?.parentElement?.classList?.add('hidden');
  }
}

// Called after the player list is populated to apply saved character.
function applyCharacterSelection(autoPlayer = null) {
  const char = getSavedChar();
  if (autoPlayer) {
    // Explicit override (from URL param)
    document.getElementById('player-select').value = autoPlayer;
    _updateCharWarning(null);
    return;
  }
  if (char?.name) {
    const found = autoSelectSavedPlayer();
    _updateCharWarning(found);
    // Only hide dropdown when character was actually found
    const sel = document.getElementById('player-select');
    if (sel) sel.parentElement.classList.toggle('hidden', found === true);
  }
}

// ── Rendering ──────────────────────────────────────────────────────────────────

function renderResults(data) {
  const el = document.getElementById('results');

  // Pre-fetch icons for all cooldowns + burst window abilities + defensives + dtk abilities
  const spellIds = Object.values(data.cd_spell_ids || {});
  const bwAbilityIds = (data.burst_windows || []).flatMap(bw =>
    (bw.ability_breakdown || []).map(a => a.spell_id)
  );
  const playerBwIds = (data.player_burst_windows || []).flatMap(bw =>
    (bw.ability_breakdown || []).map(a => a.spell_id)
  );
  const defensiveIds = (data.player_defensives || []).map(d => d.spell_id);
  const dtkIds = (data.player_dmg_taken_by_ability || []).map(a => a.spell_id);
  const allIds = [...new Set([...spellIds, ...bwAbilityIds, ...playerBwIds, ...defensiveIds, ...dtkIds])];
  if (allIds.length) fetchSpellIcons(allIds).then(() => _refreshIcons(el));

  const byCD = {};
  const ruleFindings = [];

  for (const f of data.findings) {
    if (f.severity === 'success') continue;
    if (f.category === 'hold_suggestion' && f.details?.cd_name) {
      const n = f.details.cd_name;
      if (!byCD[n]) byCD[n] = { issues: [], holds: [] };
      byCD[n].holds.push(f);
    } else if (f.category === 'rule_violation') {
      ruleFindings.push(f);
    } else if (f.cd_name || f.details?.cd_name) {
      const n = f.cd_name || f.details?.cd_name;
      if (!byCD[n]) byCD[n] = { issues: [], holds: [] };
      byCD[n].issues.push(f);
    } else {
      ruleFindings.push(f);
    }
  }

  for (const f of data.findings) {
    if (f.severity !== 'success') continue;
    const n = f.cd_name;
    if (n && !byCD[n]) byCD[n] = { issues: [], holds: [] };
    if (n) byCD[n].success = f;
  }

  const cdSpellIds = data.cd_spell_ids || {};

  const cdHtml = Object.entries(byCD).map(([name, bucket]) =>
    renderCDCard(name, bucket, cdSpellIds[name])
  ).join('') || (!ruleFindings.length ? '<div class="no-findings">✓ No significant issues detected.</div>' : '');

  let rulesHtml = '';
  if (ruleFindings.length) {
    rulesHtml = `<p class="section-label" style="margin-top:18px">Rotation Rules</p>
      <div class="rule-list">${ruleFindings.map(renderRuleItem).join('')}</div>`;
  }

  let compHtml = '';
  if (data.parse_comparison?.length) {
    compHtml = renderParseComparison(data.parse_comparison, data.player_fight_duration_s);
  }

  let burstHtml = '';
  if (data.burst_windows?.length) {
    burstHtml = renderBurstWindows(data.burst_windows, data.player_burst_windows || []);
  }

  let defHtml = '';
  if (data.player_defensives?.length) {
    defHtml = renderDefensives(data.player_defensives, data.top_defensives_summary || []);
  }

  let dtkHtml = '';
  if (data.player_dmg_taken_by_ability?.length) {
    dtkHtml = renderDamageTaken(
      data.player_dmg_taken_segments || [],
      data.player_dmg_taken_by_ability || [],
      data.player_total_dmg_taken || 0,
      data.top_avg_dmg_taken_segments || [],
      data.dmg_segment_size_s || 30,
    );
  }

  el.innerHTML = `
    <div class="result-header">
      <h2>${data.player} — ${formatSpec(data.spec)}</h2>
    </div>
    <div class="cd-list">${cdHtml}</div>
    ${rulesHtml}
    ${compHtml}
    ${burstHtml}
    ${defHtml}
    ${dtkHtml}
  `;

  el.classList.remove('hidden');
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// After icons load, refresh icon placeholders and ability name spans
function _refreshIcons(container) {
  container.querySelectorAll('[data-spell-id]').forEach(el => {
    const sid = el.dataset.spellId;
    const info = _iconCache[sid];
    if (info?.icon && !el.querySelector('img')) {
      const img = document.createElement('img');
      img.className = 'spell-icon spell-icon-small';
      img.src = `https://wow.zamimg.com/images/wow/icons/small/${info.icon}.jpg`;
      img.alt = info.name || '';
      img.loading = 'lazy';
      img.onerror = () => img.style.display = 'none';
      el.prepend(img);
    }
  });
  // Fill in ability name spans from the cache
  container.querySelectorAll('.bw-ab-name[data-wowhead]').forEach(el => {
    if (el.textContent) return;
    const m = el.dataset.wowhead?.match(/spell=(\d+)/);
    if (!m) return;
    const info = _iconCache[m[1]];
    if (info?.name) el.textContent = info.name;
  });
  // Fill damage-taken ability name spans
  container.querySelectorAll('[data-spell-id-name]').forEach(el => {
    const sid = el.getAttribute('data-spell-id-name');
    const info = _iconCache[sid];
    if (info?.name) el.textContent = info.name;
  });
}

function renderCDCard(name, bucket, spellId) {
  const hasCritical = bucket.issues.some(f => f.severity === 'critical');
  const hasIssue    = bucket.issues.length > 0 || bucket.holds.length > 0;
  const cls = hasCritical ? 'has-critical' : hasIssue ? 'has-issue' : '';
  const chevron = hasIssue ? '<span class="cd-chevron">▶</span>' : '';

  const metaParts = [];
  for (const f of bucket.issues) {
    if (f.category === 'lost_cooldown')      metaParts.push(`<span class="warn">${categoryIconHtml('lost_cooldown')} lost cast</span>`);
    else if (f.category === 'cooldown_delay')     metaParts.push(`<span class="warn">${categoryIconHtml('cooldown_delay')} held</span>`);
    else if (f.category === 'cooldown_alignment') metaParts.push(`<span class="warn">${categoryIconHtml('cooldown_alignment')} BL miss</span>`);
    else if (f.category === 'cast_efficiency')    metaParts.push(`<span class="warn">${categoryIconHtml('cast_efficiency')} downtime</span>`);
  }
  if (bucket.holds.length)
    metaParts.push(`<span class="warn">${categoryIconHtml('hold_suggestion')} ${bucket.holds.length} hold tip${bucket.holds.length > 1 ? 's' : ''}</span>`);
  const meta = metaParts.length ? `<span class="cd-meta">${metaParts.join(' · ')}</span>` : '';

  const bodyItems = [...bucket.issues, ...bucket.holds].map(f => {
    const icon = categoryIconHtml(f.category);
    const ts = f.timestamp_ms != null ? `<span class="cd-issue-ts">${formatMs(f.timestamp_ms)}</span>` : '';
    const remedy = f.details?.remedy ? `<div class="cd-remedy">${f.details.remedy}</div>` : '';
    return `<div class="cd-issue">${icon}${ts}<span class="cd-issue-msg">${f.message}</span>${remedy}</div>`;
  }).join('');

  const iconSlot = spellId ? `<span class="cd-icon-slot" data-spell-id="${spellId}">${spellIconHtml(spellId)}</span>` : '';

  return `
    <div class="cd-card ${cls} open" onclick="this.classList.toggle('open')">
      <div class="cd-card-header">
        ${iconSlot}
        <div class="cd-dot"></div>
        <span class="cd-name">${name}</span>
        ${meta}
        ${chevron}
      </div>
      ${hasIssue ? `<div class="cd-card-body">${bodyItems}</div>` : ''}
    </div>`;
}

function renderRuleItem(f) {
  const icon = categoryIconHtml(f.category || 'rule_violation');
  const ts = f.timestamp_ms != null ? `<span class="rule-item-ts">${formatMs(f.timestamp_ms)}</span>` : '';
  const remedy = f.details?.remedy ? `<div class="rule-remedy">${f.details.remedy}</div>` : '';
  const sev = f.severity === 'warning' ? 'sev-warning' : '';
  return `<div class="rule-item ${sev}">${icon}${ts}<span class="rule-item-msg">${f.message}</span>${remedy}</div>`;
}

// ── Parse comparison table ───────────────────────────────────────────────────

function _delta(player, top, stddev) {
  if (player == null || top == null) return '<span class="delta-ok">—</span>';
  const diff = player - top;
  const sd = stddev || 0.05;
  const cls = diff >= 0 ? 'delta-good' : Math.abs(diff) > sd ? 'delta-bad' : 'delta-ok';
  const sign = diff >= 0 ? '+' : '';
  return `<span class="${cls}">${sign}${diff.toFixed(2)}</span>`;
}

function renderParseComparison(comparison, playerDurS) {
  const rows = comparison.map(cd => {
    const upmDelta = _delta(cd.player_uses_per_min, cd.top_avg_uses_per_min, cd.top_stddev_uses_per_min);
    const firstDelta = cd.player_first_cast_s != null && cd.top_avg_first_cast_s != null
      ? _delta(-(cd.player_first_cast_s - cd.top_avg_first_cast_s), 0, cd.top_stddev_first_cast_s)
      : '<span class="delta-ok">—</span>';
    const blCell = cd.top_bl_pct > 0
      ? `${cd.player_bl_offset_s != null ? (cd.player_bl_offset_s >= 0 ? '+' : '') + cd.player_bl_offset_s + 's' : '—'} <span class="delta-ok">/ avg ${cd.top_avg_bl_offset_s != null ? (cd.top_avg_bl_offset_s >= 0 ? '+' : '') + cd.top_avg_bl_offset_s + 's' : '—'}</span>`
      : '<span class="delta-ok">—</span>';
    return `<tr>
      <td style="font-weight:600">${cd.name}</td>
      <td>${cd.player_uses} <span class="delta-ok">(${cd.player_uses_per_min}/min)</span> ${upmDelta}</td>
      <td>${cd.player_first_cast_s != null ? formatDuration(cd.player_first_cast_s) : '—'} ${firstDelta}</td>
      <td>${blCell}</td>
      <td class="delta-ok">${cd.sample_count}</td>
    </tr>`;
  }).join('');

  return `
    <p class="section-label" style="margin-top:20px">vs Top ${comparison[0]?.sample_count || ''} Parses</p>
    <div class="comp-table-wrap">
      <table class="comp-table">
        <thead><tr>
          <th>Cooldown</th>
          <th>Uses/min</th>
          <th>First cast</th>
          <th>BL offset</th>
          <th>Samples</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

// ── Burst window deep dive ───────────────────────────────────────────────────

function renderBurstWindows(topBws, playerBws) {
  // Match player burst windows to the closest top-parse window by time
  function findPlayerWindow(topTimeS) {
    let best = null, bestDiff = 20;
    for (const bw of playerBws) {
      const d = Math.abs(bw.time_s - topTimeS);
      if (d < bestDiff) { bestDiff = d; best = bw; }
    }
    return best;
  }

  const cards = topBws.map((bw, idx) => {
    const playerBw = findPlayerWindow(bw.time_s);
    const topPct  = bw.pct_avg;
    const playerPct = playerBw?.pct_of_total ?? null;
    const minPct  = bw.pct_min ?? topPct - 0.02;
    const maxPct  = bw.pct_max ?? topPct + 0.02;

    let statusClass = 'bw-ok';
    let statusLabel = 'On Par';
    if (playerPct === null) {
      statusClass = 'bw-missing'; statusLabel = 'No data';
    } else if (playerPct < minPct - (bw.pct_stddev || 0.01)) {
      statusClass = 'bw-low'; statusLabel = 'Below range';
    } else if (playerPct >= topPct - (bw.pct_stddev || 0.005)) {
      statusClass = 'bw-ok'; statusLabel = 'On Par';
    } else {
      statusClass = 'bw-warn'; statusLabel = 'Slightly below';
    }

    const cdsStr = bw.common_cds?.length ? bw.common_cds.join(', ') : '—';
    const playerPctStr = playerPct != null ? (playerPct * 100).toFixed(1) + '%' : '—';
    const topPctStr = (topPct * 100).toFixed(1) + '%';

    // Ability breakdown — shown only when expanded and player is below range
    const showBreakdown = playerPct !== null && playerPct < maxPct;
    let breakdownHtml = '';
    if (showBreakdown && bw.ability_breakdown?.length) {
      // Merge top-parse abilities with player abilities
      const playerAbMap = {};
      for (const a of (playerBw?.ability_breakdown || [])) playerAbMap[a.spell_id] = a;

      const rows = bw.ability_breakdown.map(topAb => {
        const sid = topAb.spell_id;
        const playerAb = playerAbMap[sid];
        const topPctStr = (topAb.avg_pct * 100).toFixed(1) + '%';
        const plPctStr  = playerAb ? (playerAb.pct * 100).toFixed(1) + '%' : '—';
        const diff = playerAb ? playerAb.pct - topAb.avg_pct : null;
        const diffCls = diff === null ? 'delta-ok' : diff >= 0 ? 'delta-good' : 'delta-bad';
        const diffStr = diff !== null ? `<span class="${diffCls}">${diff >= 0 ? '+' : ''}${(diff*100).toFixed(1)}%</span>` : '';
        const iconSlot = `<span data-spell-id="${sid}">${spellIconHtml(sid)}</span>`;
        return `<tr>
          <td>${iconSlot} <span class="bw-ab-name" data-wowhead="spell=${sid}"></span></td>
          <td>${plPctStr} ${diffStr}</td>
          <td class="delta-ok">${topPctStr}</td>
        </tr>`;
      }).join('');

      // Also add player-only abilities not in top-parse breakdown
      const topIds = new Set(bw.ability_breakdown.map(a => a.spell_id));
      for (const pa of (playerBw?.ability_breakdown || [])) {
        if (!topIds.has(pa.spell_id)) {
          const sid = pa.spell_id;
          rows + `<tr>
            <td><span data-spell-id="${sid}">${spellIconHtml(sid)}</span></td>
            <td>${(pa.pct * 100).toFixed(1)}% <span class="delta-good">+top</span></td>
            <td class="delta-ok">—</td>
          </tr>`;
        }
      }

      breakdownHtml = `
        <div class="bw-breakdown">
          <table class="bw-ab-table">
            <thead><tr><th>Ability</th><th>You</th><th>Top avg</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`;
    }

    const expandBtn = showBreakdown && bw.ability_breakdown?.length
      ? `<button class="bw-expand-btn" onclick="this.closest('.bw-card').classList.toggle('expanded')">Detail ▾</button>`
      : '';

    return `
      <div class="bw-card ${statusClass}" id="bw-card-${idx}">
        <div class="bw-card-header">
          <span class="bw-time">${formatDuration(bw.time_s)}</span>
          <div class="bw-bar-wrap">
            <div class="bw-bar" style="--top:${Math.min(topPct*400, 100)}%;--player:${playerPct != null ? Math.min(playerPct*400,100) : 0}%"></div>
          </div>
          <span class="bw-pct-player">${playerPctStr}</span>
          <span class="bw-pct-sep">/</span>
          <span class="bw-pct-top">${topPctStr}</span>
          <span class="bw-status-badge bw-badge-${statusClass}">${statusLabel}</span>
          <span class="bw-cds">${cdsStr}</span>
          ${expandBtn}
        </div>
        ${breakdownHtml}
      </div>`;
  }).join('');

  return `
    <p class="section-label" style="margin-top:20px">Burst Windows</p>
    <div class="bw-legend">
      <span class="bw-legend-item"><span class="bw-dot bw-dot-player"></span> You</span>
      <span class="bw-legend-item"><span class="bw-dot bw-dot-top"></span> Top parse avg</span>
    </div>
    <div class="bw-list">${cards}</div>`;
}

function renderDefensives(playerDefs, topSummary) {
  const topByName = {};
  for (const t of topSummary) topByName[t.name] = t;

  const rows = playerDefs.map(def => {
    const top = topByName[def.name];
    const topAvg = top ? top.avg_uses.toFixed(1) : '—';
    const usesClass = top
      ? (def.uses >= top.avg_uses ? 'delta-good' : 'delta-bad')
      : '';
    const totalDmg = def.windows.reduce((s, w) => s + (w.dmg_during || 0), 0);
    const dmgStr = totalDmg > 0 ? formatNumber(totalDmg) : '—';

    const windowsList = def.windows.length
      ? def.windows.map(w => `<span class="def-window">${formatDuration(w.start_s)}–${formatDuration(w.end_s)} <small>${formatNumber(w.dmg_during)}</small></span>`).join(' ')
      : '<span class="def-none">not used</span>';

    return `<tr>
      <td class="def-icon-name">
        <span data-spell-id="${def.spell_id}">${spellIconHtml(def.spell_id, 20)}</span>
        ${def.name}
      </td>
      <td class="${usesClass}">${def.uses}</td>
      <td>${topAvg}</td>
      <td>${dmgStr}</td>
      <td class="def-windows-cell">${windowsList}</td>
    </tr>`;
  }).join('');

  return `
    <p class="section-label" style="margin-top:20px">Defensives</p>
    <div class="def-table-wrap">
      <table class="def-table">
        <thead>
          <tr>
            <th>Spell</th>
            <th>Uses</th>
            <th>Top avg</th>
            <th>Dmg absorbed</th>
            <th>Usage windows</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function renderDamageTaken(segments, byAbility, total, topAvgSegs, segSizeS) {
  if (!segments.length) return '';

  // Bar chart of damage taken per 30s segment
  const maxVal = Math.max(1, ...segments, ...topAvgSegs);
  const barCells = segments.map((val, i) => {
    const topVal = topAvgSegs[i] ?? 0;
    const pct = Math.round(val / maxVal * 100);
    const topPct = Math.round(topVal / maxVal * 100);
    const t = i * segSizeS;
    return `<div class="dtk-bar-group" title="${formatDuration(t)}: ${formatNumber(val)}">
      <div class="dtk-bar-top" style="height:${topPct}%" title="Top avg: ${formatNumber(topVal)}"></div>
      <div class="dtk-bar-player" style="height:${pct}%"></div>
      <div class="dtk-bar-label">${formatDuration(t)}</div>
    </div>`;
  }).join('');

  // Ability breakdown table with Wowhead tooltips
  const abilityRows = byAbility.map(a => {
    const sid = a.spell_id;
    return `<tr>
      <td>
        <span data-spell-id="${sid}">${spellIconHtml(sid, 20)}</span>
        <a class="dtk-wowhead" href="https://www.wowhead.com/spell=${sid}" target="_blank" rel="noreferrer"
           data-wowhead="spell=${sid}"><span class="bw-ab-name" data-spell-id-name="${sid}">${sid}</span></a>
      </td>
      <td>${formatNumber(a.damage)}</td>
      <td>${(a.pct * 100).toFixed(1)}%</td>
    </tr>`;
  }).join('');

  return `
    <p class="section-label" style="margin-top:20px">Damage Taken</p>
    <div class="dtk-section">
      <div class="dtk-total">Total: <strong>${formatNumber(total)}</strong></div>
      <div class="dtk-legend">
        <span class="dtk-dot dtk-dot-player"></span> You &nbsp;
        <span class="dtk-dot dtk-dot-top"></span> Top avg
      </div>
      <div class="dtk-bars">${barCells}</div>
      <p class="section-sublabel">Top sources</p>
      <table class="dtk-ability-table">
        <thead><tr><th>Ability</th><th>Damage</th><th>% of total</th></tr></thead>
        <tbody>${abilityRows}</tbody>
      </table>
    </div>`;
}

// Update ability name spans after icons load
function _applyAbilityNames(container) {
  container.querySelectorAll('[data-spell-id-name]').forEach(el => {
    const sid = el.getAttribute('data-spell-id-name');
    const info = _iconCache[sid];
    if (info?.name) el.textContent = info.name;
  });
}
