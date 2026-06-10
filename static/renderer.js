// Shared rendering — used by index.html (post-raid) and live.html (live)

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

function showError(msg) {
  const el = document.getElementById('error-box');
  el.textContent = `⚠ ${msg}`;
  el.classList.remove('hidden');
}

function clearError() {
  document.getElementById('error-box').classList.add('hidden');
}

// ── Rendering ──────────────────────────────────────────────────────────────────

function renderResults(data) {
  const el = document.getElementById('results');

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

  const cdHtml = Object.entries(byCD).map(([name, bucket]) => renderCDCard(name, bucket)).join('')
    || (!ruleFindings.length ? '<div class="no-findings">✓ No significant issues detected.</div>' : '');

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

function renderCDCard(name, bucket) {
  const hasCritical = bucket.issues.some(f => f.severity === 'critical');
  const hasIssue    = bucket.issues.length > 0 || bucket.holds.length > 0;
  const cls = hasCritical ? 'has-critical' : hasIssue ? 'has-issue' : '';
  const chevron = hasIssue ? '<span class="cd-chevron">▶</span>' : '';

  const metaParts = [];
  for (const f of bucket.issues) {
    if (f.category === 'lost_cooldown')      metaParts.push(`<span class="warn">lost cast</span>`);
    else if (f.category === 'cooldown_delay')     metaParts.push(`<span class="warn">held</span>`);
    else if (f.category === 'cooldown_alignment') metaParts.push(`<span class="warn">BL miss</span>`);
    else if (f.category === 'cast_efficiency')    metaParts.push(`<span class="warn">downtime</span>`);
  }
  if (bucket.holds.length)
    metaParts.push(`<span class="warn">${bucket.holds.length} hold tip${bucket.holds.length > 1 ? 's' : ''}</span>`);
  const meta = metaParts.length ? `<span class="cd-meta">${metaParts.join(' · ')}</span>` : '';

  const bodyItems = [...bucket.issues, ...bucket.holds].map(f => {
    const ts = f.timestamp_ms != null ? `<span class="cd-issue-ts">${formatMs(f.timestamp_ms)}</span>` : '';
    const remedy = f.details?.remedy ? `<div class="cd-remedy">${f.details.remedy}</div>` : '';
    return `<div class="cd-issue">${ts}<span class="cd-issue-msg">${f.message}</span>${remedy}</div>`;
  }).join('');

  return `
    <div class="cd-card ${cls} open" onclick="this.classList.toggle('open')">
      <div class="cd-card-header">
        <div class="cd-dot"></div>
        <span class="cd-name">${name}</span>
        ${meta}
        ${chevron}
      </div>
      ${hasIssue ? `<div class="cd-card-body">${bodyItems}</div>` : ''}
    </div>`;
}

function renderRuleItem(f) {
  const ts = f.timestamp_ms != null ? `<span class="rule-item-ts">${formatMs(f.timestamp_ms)}</span>` : '';
  const remedy = f.details?.remedy ? `<div class="rule-remedy">${f.details.remedy}</div>` : '';
  const sev = f.severity === 'warning' ? 'sev-warning' : '';
  return `<div class="rule-item ${sev}">${ts}<span class="rule-item-msg">${f.message}</span>${remedy}</div>`;
}
