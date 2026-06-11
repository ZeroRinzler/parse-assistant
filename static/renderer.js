// Shared rendering — used by index.html (post-raid) and live.html (live)

// ── API fetch helper ──────────────────────────────────────────────────────────
// Wraps fetch+json with a clear error when the backend is unavailable (e.g. on
// GitHub Pages the API routes don't exist and return HTML 404 pages).
async function apiFetch(url, opts) {
  const resp = await fetch(url, opts);
  const ct = resp.headers.get('content-type') || '';
  if (!ct.includes('json')) {
    throw new Error(
      'Backend server is not available. Run the server locally to use the analyzer.'
    );
  }
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.detail || `Request failed (${resp.status})`);
  return data;
}

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
  const icon = info.icon.replace(/\.jpg$/i, '');
  return `<img class="spell-icon spell-icon-${size}" src="https://wow.zamimg.com/images/wow/icons/${size}/${icon}.jpg" alt="${info.name || ''}" loading="lazy" onerror="this.style.display='none'" />`;
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

// ── Linked character auto-selection ──────────────────────────────────────────
// Matches any WCL-linked character name against the player dropdown.

function autoSelectLinkedPlayer() {
  const chars = (typeof wclGetCachedUserChars !== 'undefined') ? wclGetCachedUserChars() : [];
  if (!chars.length) return false;
  const names = new Set(chars.map(c => c.name.toLowerCase()));
  const sel = document.getElementById('player-select');
  if (!sel) return false;
  for (const opt of sel.options) {
    if (names.has(opt.textContent.split(' — ')[0].toLowerCase())) {
      sel.value = opt.value;
      return true;
    }
  }
  return false;
}

// Called after the player list is populated to apply character selection.
function applyCharacterSelection(autoPlayer = null) {
  if (autoPlayer) {
    document.getElementById('player-select').value = autoPlayer;
    return;
  }
  autoSelectLinkedPlayer();
}

// ── Rendering ──────────────────────────────────────────────────────────────────

function renderResults(data) {
  const el = document.getElementById('results');

  // Seed icon cache from masterData.abilities bundled in the response (replaces the
  // broken gameData.spell() API path). Fall back to the DB-cached /api/spell-icons
  // for any IDs that weren't in this report's masterData.
  if (data.ability_icons) Object.assign(_iconCache, data.ability_icons);

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
  // Fetch any IDs not already in cache (legacy DB entries for older spell IDs)
  const stillMissing = allIds.filter(id => !_iconCache[id] && !_iconCache[String(id)]);
  const iconPromise = stillMissing.length ? fetchSpellIcons(stillMissing) : Promise.resolve();
  iconPromise.then(() => _refreshIcons(el));

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
    burstHtml = renderBurstWindows(data.burst_windows, data.player_burst_windows || [], data.player_fight_duration_s ?? Infinity);
  }

  let defHtml = '';
  if (data.player_defensives?.length) {
    defHtml = renderDefensives(
      data.player_defensives,
      data.top_defensives_summary || [],
      data.player_fight_duration_s || 0,
    );
  }

  let dtkHtml = '';
  if (data.player_dmg_taken_by_ability?.length) {
    dtkHtml = renderDamageTaken(
      data.player_dmg_taken_by_ability,
      data.player_total_dmg_taken || 0,
      data.top_dtk_comparison || [],
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
      img.src = `https://wow.zamimg.com/images/wow/icons/small/${info.icon.replace(/\.jpg$/i, '')}.jpg`;
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

// ── Shared comparison chart ───────────────────────────────────────────────────
// rows: [{labelHtml, playerVal, topAvg?, topMin?, topMax?, highlight?}]
// opts: {higherIsBetter, unit ('pct'|'k'), noDataText}

function renderComparisonChart(rows, opts = {}) {
  const { higherIsBetter = true, unit = 'pct', noDataText = 'Re-ingest parses to compare with top 10' } = opts;

  function fmtV(v) {
    if (v == null) return '—';
    return unit === 'pct' ? (v * 100).toFixed(1) + '%' : formatNumber(v);
  }

  const allVals = rows.flatMap(r => [r.playerVal, r.topAvg, r.topMax].filter(v => v != null));
  const maxVal = opts.maxVal ?? Math.max(...allVals, 0.001);
  const hasTopData = rows.some(r => r.topAvg != null);

  const items = rows.map(r => {
    const pPct  = r.playerVal != null ? Math.min(r.playerVal / maxVal * 100, 100) : null;
    const tPct  = r.topAvg    != null ? Math.min(r.topAvg    / maxVal * 100, 100) : null;
    const tMinP = r.topMin    != null ? Math.min(r.topMin    / maxVal * 100, 100) : null;
    const tMaxP = r.topMax    != null ? Math.min(r.topMax    / maxVal * 100, 100) : null;

    // delta class for player value
    let dCls = '';
    if (r.playerVal != null && r.topAvg != null) {
      const lo = r.topMin ?? r.topAvg * 0.8, hi = r.topMax ?? r.topAvg * 1.2;
      if (higherIsBetter) dCls = r.playerVal >= r.topAvg ? 'delta-good' : r.playerVal >= lo ? 'delta-warn' : 'delta-bad';
      else                dCls = r.playerVal <= r.topAvg ? 'delta-good' : r.playerVal <= hi ? 'delta-warn' : 'delta-bad';
    }

    // Candle range indicator on the top bar track
    let candle = '';
    if (tMinP != null && tMaxP != null && tMaxP > tMinP) {
      const rW = tMaxP - tMinP;
      const avgOff = tPct != null ? Math.min(((tPct - tMinP) / rW) * 100, 100) : 50;
      candle = `<div class="cmp-candle" style="left:${tMinP.toFixed(1)}%;width:${rW.toFixed(1)}%">` +
               `<div class="cmp-candle-tick" style="left:${avgOff.toFixed(1)}%"></div></div>`;
    }

    const playerRow = `<div class="cmp-subrow">
      <span class="cmp-leg player"></span>
      <div class="cmp-track">${pPct != null ? `<div class="cmp-fill player" style="width:${pPct.toFixed(1)}%"></div>` : ''}</div>
      <span class="cmp-val ${dCls}">${fmtV(r.playerVal)}</span>
    </div>`;

    const topRow = hasTopData ? `<div class="cmp-subrow">
      <span class="cmp-leg top"></span>
      <div class="cmp-track">${tPct != null ? candle + `<div class="cmp-fill top" style="width:${tPct.toFixed(1)}%"></div>` : ''}</div>
      <span class="cmp-val top">${fmtV(r.topAvg)}${r.topMin != null ? ` <span class="cmp-range">${fmtV(r.topMin)}–${fmtV(r.topMax)}</span>` : ''}</span>
    </div>` : '';

    return `<div class="cmp-item${r.highlight ? ' cmp-highlight' : ''}">
      <div class="cmp-item-label">${r.labelHtml}</div>
      <div class="cmp-item-bars">${playerRow}${topRow}</div>
    </div>`;
  });

  const legend = `<div class="cmp-legend">
    <span class="cmp-leg-item"><span class="cmp-leg player"></span> You</span>
    ${hasTopData ? `<span class="cmp-leg-item"><span class="cmp-leg top"></span> Top 10 avg <span class="cmp-range-note">(shaded range)</span></span>` : `<span class="cmp-no-data">${noDataText}</span>`}
  </div>`;

  return `<div class="cmp-chart">${legend}${items.join('')}</div>`;
}

// ── Burst windows ─────────────────────────────────────────────────────────────
// Rank-order matching: fight lengths differ between player and top parses, so
// time-based proximity fails. 1st biggest burst = 1st biggest burst.

function renderBurstWindows(topBws, playerBws, fightDurS) {
  if (!topBws.length) return '';

  const allVals = topBws.flatMap((bw, i) => {
    const p = playerBws[i]?.pct_of_total;
    return [bw.pct_avg, bw.pct_max, p].filter(v => v != null);
  });
  const maxVal = Math.max(...allVals, 0.01);

  const cards = topBws.map((bw, idx) => {
    const notReached = bw.time_s > fightDurS;
    const playerBw  = notReached ? null : (playerBws[idx] ?? null);
    const topPct    = bw.pct_avg;
    const playerPct = playerBw?.pct_of_total ?? null;
    const minPct    = bw.pct_min ?? topPct * 0.7;
    const maxPct    = bw.pct_max ?? topPct * 1.3;

    let borderCls = 'bw-ok', badge = 'On Par', badgeCls = 'bw-badge-bw-ok';
    if (notReached) {
      borderCls = 'bw-future'; badge = 'Not reached'; badgeCls = 'bw-badge-bw-future';
    } else if (playerPct === null) {
      borderCls = 'bw-missing'; badge = 'No data'; badgeCls = 'bw-badge-bw-missing';
    } else if (playerPct < minPct - (bw.pct_stddev ?? 0.01)) {
      borderCls = 'bw-low'; badge = 'Below range'; badgeCls = 'bw-badge-bw-low';
    } else if (playerPct < topPct - (bw.pct_stddev ?? 0.005)) {
      borderCls = 'bw-warn'; badge = 'Slightly below'; badgeCls = 'bw-badge-bw-warn';
    }

    const pBar  = playerPct != null ? Math.min(playerPct / maxVal * 100, 100) : 0;
    const tBar  = Math.min(topPct / maxVal * 100, 100);
    const tMinP = Math.min(minPct / maxVal * 100, 100);
    const tMaxP = Math.min(maxPct / maxVal * 100, 100);
    const rW    = tMaxP - tMinP;
    const avgOff = rW > 0 ? Math.min(((tBar - tMinP) / rW) * 100, 100) : 50;

    const candleHtml = rW > 0.5
      ? `<div class="cmp-candle" style="left:${tMinP.toFixed(1)}%;width:${rW.toFixed(1)}%"><div class="cmp-candle-tick" style="left:${avgOff.toFixed(1)}%"></div></div>`
      : '';

    // For "not reached" windows: show only the top-parse bar as context, no player row
    let cmpHtml;
    if (notReached) {
      cmpHtml = `<div class="bw-cmp-wrap bw-future-wrap">
        <div class="cmp-subrow">
          <span class="cmp-leg top"></span>
          <div class="cmp-track">${candleHtml}<div class="cmp-fill top" style="width:${tBar.toFixed(1)}%"></div></div>
          <span class="cmp-val top">${(topPct*100).toFixed(1)}% avg</span>
        </div>
      </div>`;
    } else {
      cmpHtml = `<div class="bw-cmp-wrap">
        <div class="cmp-subrow">
          <span class="cmp-leg player"></span>
          <div class="cmp-track"><div class="cmp-fill player" style="width:${pBar.toFixed(1)}%"></div></div>
          <span class="cmp-val">${playerPct != null ? (playerPct*100).toFixed(1)+'%' : '—'}</span>
        </div>
        <div class="cmp-subrow">
          <span class="cmp-leg top"></span>
          <div class="cmp-track">${candleHtml}<div class="cmp-fill top" style="width:${tBar.toFixed(1)}%"></div></div>
          <span class="cmp-val top">${(topPct*100).toFixed(1)}% <span class="cmp-range">${(minPct*100).toFixed(1)}%–${(maxPct*100).toFixed(1)}%</span></span>
        </div>
      </div>`;
    }

    let breakdownHtml = '';
    if (bw.ability_breakdown?.length) {
      const playerAbMap = {};
      for (const a of (playerBw?.ability_breakdown || [])) playerAbMap[a.spell_id] = a;

      const abRows = bw.ability_breakdown.map(topAb => {
        const sid = topAb.spell_id;
        const playerAb = notReached ? null : playerAbMap[sid];
        const diff = playerAb ? playerAb.pct - topAb.avg_pct : null;
        const diffCls = diff === null ? '' : diff >= 0 ? 'delta-good' : 'delta-bad';
        const diffStr = diff !== null ? ` <span class="${diffCls}">${diff >= 0 ? '+' : ''}${(diff*100).toFixed(1)}%</span>` : '';
        return `<tr>
          <td><span class="cd-icon-slot" data-spell-id="${sid}">${spellIconHtml(sid)}</span> <a href="https://www.wowhead.com/spell=${sid}" target="_blank" class="dtk-wowhead"><span data-spell-id-name="${sid}">${spellName(sid) || 'Spell ' + sid}</span></a></td>
          ${notReached ? '' : `<td>${playerAb ? (playerAb.pct*100).toFixed(1)+'%' : '—'}${diffStr}</td>`}
          <td class="delta-ok">${(topAb.avg_pct*100).toFixed(1)}%</td>
        </tr>`;
      }).join('');

      breakdownHtml = `<div class="bw-breakdown">
        <table class="bw-ab-table">
          <thead><tr><th>Ability</th>${notReached ? '' : '<th>You</th>'}<th>Top avg</th></tr></thead>
          <tbody>${abRows}</tbody>
        </table>
      </div>`;
    }

    const expandBtn = bw.ability_breakdown?.length
      ? `<button class="bw-expand-btn" onclick="this.closest('.bw-card').classList.toggle('expanded')">Detail ▾</button>`
      : '';

    const cdsStr = bw.common_cds?.length ? bw.common_cds.join(', ') : '—';

    return `<div class="bw-card ${borderCls}">
      <div class="bw-card-header">
        <span class="bw-time">${formatDuration(bw.time_s)}</span>
        <span class="bw-status-badge ${badgeCls}">${badge}</span>
        <span class="bw-cds">${cdsStr}</span>
        ${expandBtn}
      </div>
      ${cmpHtml}
      ${breakdownHtml}
    </div>`;
  }).join('');

  return `
    <p class="section-label" style="margin-top:20px">Burst Windows</p>
    <div class="cmp-legend">
      <span class="cmp-leg-item"><span class="cmp-leg player"></span> You</span>
      <span class="cmp-leg-item"><span class="cmp-leg top"></span> Top 10 avg <span class="cmp-range-note">(shaded range)</span></span>
    </div>
    <div class="bw-list">${cards}</div>`;
}

function renderDefensives(playerDefs, topSummary, fightDurS) {
  if (!playerDefs?.length) return '';

  const topBySpellId = {};
  for (const t of (topSummary || [])) topBySpellId[t.spell_id] = t;

  const cards = playerDefs.map(def => {
    const top = topBySpellId[def.spell_id];
    const expected = def.cooldown > 0 ? Math.floor(fightDurS / def.cooldown) : null;

    const maxVal = Math.max(def.uses, top?.max_uses ?? 0, expected ?? 0, 1);
    const pBar   = Math.min(def.uses / maxVal * 100, 100);
    const tBar   = top ? Math.min(top.avg_uses / maxVal * 100, 100) : null;
    const tMinP  = top?.min_uses != null ? Math.min(top.min_uses / maxVal * 100, 100) : null;
    const tMaxP  = top?.max_uses != null ? Math.min(top.max_uses / maxVal * 100, 100) : null;
    const rW     = (tMinP != null && tMaxP != null && tMaxP > tMinP) ? tMaxP - tMinP : 0;
    const avgOff = rW > 0 && tBar != null ? Math.min(((tBar - tMinP) / rW) * 100, 100) : 50;

    let pValCls = '';
    if (top) pValCls = def.uses >= top.avg_uses ? 'delta-good' : def.uses >= top.min_uses ? 'delta-warn' : 'delta-bad';

    const candleHtml = rW > 0.5
      ? `<div class="cmp-candle" style="left:${tMinP.toFixed(1)}%;width:${rW.toFixed(1)}%"><div class="cmp-candle-tick" style="left:${avgOff.toFixed(1)}%"></div></div>`
      : '';

    const expStr    = expected != null ? ` / ~${expected} expected` : '';
    const topValStr = top ? `${top.avg_uses.toFixed(1)} avg <span class="cmp-range">(${top.min_uses}–${top.max_uses})</span>` : '';

    const cmpHtml = `<div class="bw-cmp-wrap">
      <div class="cmp-subrow">
        <span class="cmp-leg player"></span>
        <div class="cmp-track"><div class="cmp-fill player" style="width:${pBar.toFixed(1)}%"></div></div>
        <span class="cmp-val ${pValCls}">${def.uses} use${def.uses !== 1 ? 's' : ''}${expStr}</span>
      </div>
      ${tBar != null
        ? `<div class="cmp-subrow">
          <span class="cmp-leg top"></span>
          <div class="cmp-track">${candleHtml}<div class="cmp-fill top" style="width:${tBar.toFixed(1)}%"></div></div>
          <span class="cmp-val top">${topValStr}</span>
        </div>`
        : `<div class="cmp-subrow"><span class="cmp-no-data">Re-ingest to compare</span></div>`}
    </div>`;

    const windowsList = def.windows.length
      ? def.windows.map(w => {
          const dmgStr = w.dmg_during > 0 ? ` <small>${formatNumber(w.dmg_during)} absorbed</small>` : '';
          return `<span class="def-window">${formatDuration(w.start_s)}–${formatDuration(w.end_s)}${dmgStr}</span>`;
        }).join(' ')
      : '<span class="def-none">not used</span>';

    const name = def.name || spellName(def.spell_id) || `Spell ${def.spell_id}`;
    const lowUse = expected != null && def.uses < (top?.min_uses ?? expected);

    return `<div class="bw-card${lowUse ? ' bw-low' : ''}">
      <div class="bw-card-header" style="cursor:default">
        <span class="cd-icon-slot" data-spell-id="${def.spell_id}">${spellIconHtml(def.spell_id)}</span>
        <a href="https://www.wowhead.com/spell=${def.spell_id}" target="_blank" class="cd-name" style="flex:0 0 auto;text-decoration:none">${name}</a>
        <span class="bw-cds">${windowsList}</span>
      </div>
      ${cmpHtml}
    </div>`;
  }).join('');

  return `
    <p class="section-label" style="margin-top:20px">Defensives</p>
    <div class="cmp-legend">
      <span class="cmp-leg-item"><span class="cmp-leg player"></span> You</span>
      <span class="cmp-leg-item"><span class="cmp-leg top"></span> Top 10 avg <span class="cmp-range-note">(shaded range)</span></span>
    </div>
    <div class="bw-list">${cards}</div>`;
}

function renderDamageTaken(byAbility, total, topComparison) {
  if (!byAbility?.length) return '';

  const topMap = {};
  for (const t of (topComparison || [])) topMap[t.spell_id] = t;

  const tagged = byAbility.map(ab => {
    const top = topMap[ab.spell_id];
    const isOutlier = top != null && (ab.pct > top.avg_pct + Math.max(top.stddev_pct ?? 0, 0.02));
    return { ...ab, top, isOutlier };
  });

  tagged.sort((a, b) => {
    if (a.isOutlier !== b.isOutlier) return a.isOutlier ? -1 : 1;
    return b.pct - a.pct;
  });

  const outliers = tagged.filter(a => a.isOutlier);
  const allVals = tagged.flatMap(a => [a.pct, a.top?.avg_pct, a.top?.max_pct].filter(v => v != null));
  const maxVal  = Math.max(...allVals, 0.01);

  const rows = tagged.map(ab => {
    const sid = ab.spell_id;
    return {
      labelHtml: `<span style="display:flex;align-items:center;gap:6px">
        <span class="cd-icon-slot" data-spell-id="${sid}">${spellIconHtml(sid)}</span>
        <a href="https://www.wowhead.com/spell=${sid}" target="_blank" class="dtk-wowhead"><span data-spell-id-name="${sid}">${ab.name || spellName(sid) || 'Spell ' + sid}</span></a>
      </span>`,
      playerVal: ab.pct,
      topAvg:    ab.top?.avg_pct ?? null,
      topMin:    ab.top?.min_pct ?? null,
      topMax:    ab.top?.max_pct ?? null,
      highlight: ab.isOutlier,
    };
  });

  const chart = renderComparisonChart(rows, { higherIsBetter: false, unit: 'pct', maxVal,
    noDataText: 'Re-ingest parses to compare with top 10' });

  const totalStr   = total > 0 ? `Total: <strong>${formatNumber(total)}</strong>` : '';
  const outlierNote = outliers.length
    ? `<span class="outlier-note">${outliers.length} ${outliers.length === 1 ? 'source' : 'sources'} above top-10 avg</span>`
    : (topComparison?.length ? `<span class="cmp-no-data">No significant outliers vs top 10</span>` : '');

  return `
    <p class="section-label" style="margin-top:20px">Damage Taken</p>
    <div class="dtk-section">
      <div style="display:flex;align-items:center;gap:16px;margin-bottom:8px;">
        <span class="dtk-total">${totalStr}</span>
        ${outlierNote}
      </div>
      ${chart}
    </div>`;
}
