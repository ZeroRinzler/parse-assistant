// Shared rendering — used by index.html (post-raid) and live.html (live)

// ── Formatters ─────────────────────────────────────────────────────────────────

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatMs(ms) { return formatDuration(ms / 1000); }

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

const _iconCache = {};  // {spell_id: icon_name}

async function fetchSpellIcons(spellIds) {
  const missing = spellIds.filter(id => id && !(id in _iconCache));
  if (!missing.length) return;
  try {
    const resp = await fetch(`/api/spell-icons?ids=${missing.join(',')}`);
    if (resp.ok) Object.assign(_iconCache, await resp.json());
  } catch { /* icons are non-critical */ }
}

function spellIconHtml(spellId, size = 'small') {
  const icon = _iconCache[spellId];
  if (!icon) return '';
  return `<img class="spell-icon spell-icon-${size}" src="https://wow.zamimg.com/images/wow/icons/${size}/${icon}.jpg" alt="" loading="lazy" onerror="this.style.display='none'" />`;
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

  // Pre-fetch icons for all cooldowns in the response
  const spellIds = Object.values(data.cd_spell_ids || {});
  if (spellIds.length) {
    fetchSpellIcons(spellIds).then(() => _refreshIcons(el));
  }

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

  // Also add success findings as their own entries
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

  el.innerHTML = `
    <div class="result-header">
      <h2>${data.player} — ${formatSpec(data.spec)}</h2>
    </div>
    <div class="cd-list">${cdHtml}</div>
    ${rulesHtml}
  `;

  el.classList.remove('hidden');
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// After icons load, swap in the img tags that were originally empty placeholders
function _refreshIcons(container) {
  container.querySelectorAll('[data-spell-id]').forEach(el => {
    const sid = parseInt(el.dataset.spellId, 10);
    const icon = _iconCache[sid];
    if (icon && !el.querySelector('img')) {
      const img = document.createElement('img');
      img.className = 'spell-icon spell-icon-small';
      img.src = `https://wow.zamimg.com/images/wow/icons/small/${icon}.jpg`;
      img.loading = 'lazy';
      img.onerror = () => img.style.display = 'none';
      el.prepend(img);
    }
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
