#!/usr/bin/env node
/**
 * Warcraft Learner Admin CLI
 * Replaces the admin.html web UI with an interactive terminal script.
 *
 * Usage:
 *   npm run admin              → main menu
 *   npm run admin -- guides    → jump to guides
 *   npm run admin -- parses    → jump to parses
 *   npm run admin -- rulebook  → jump to rulebook
 *
 * Requires: backend running at http://localhost:8000
 */

import readline from 'readline';

const BASE = process.env.API_BASE ?? 'http://localhost:8000';

// ── Readline helpers ──────────────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(prompt) {
  return new Promise(resolve => rl.question(prompt, resolve));
}

function askList(prompt, choices) {
  const lines = choices.map((c, i) => `  [${i + 1}] ${c}`).join('\n');
  return new Promise(async resolve => {
    while (true) {
      const ans = await ask(`${prompt}\n${lines}\n> `);
      const n = parseInt(ans);
      if (n >= 1 && n <= choices.length) return resolve(n - 1);
      console.log('Invalid choice, try again.');
    }
  });
}

// ── API helpers ───────────────────────────────────────────────────────────────

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const ct = res.headers.get('content-type') ?? '';
  return ct.includes('json') ? res.json() : res.text();
}

// ── Spec selection ────────────────────────────────────────────────────────────

async function pickSpec() {
  const data = await api('GET', '/api/admin/specs').catch(() => null);
  const specs = data?.specs ?? [];
  if (specs.length === 0) {
    return await ask('Enter spec name (e.g. SubtletyRogue): ');
  }
  console.log('\nKnown specs:');
  specs.forEach((s, i) => console.log(`  [${i + 1}] ${s}`));
  const raw = await ask('Choose or type a new spec name: ');
  const n = parseInt(raw);
  return (n >= 1 && n <= specs.length) ? specs[n - 1] : raw.trim();
}

// ── Guides section ────────────────────────────────────────────────────────────

async function guidesMenu(spec) {
  while (true) {
    const guides = await api('GET', `/api/admin/guides/${spec}`).catch(() => []);
    console.log(`\n── Guides for ${spec} (${guides.length}) ─────────────────────`);
    guides.forEach((g, i) =>
      console.log(`  ${i + 1}. [${g.status}] ${g.guide_type.toUpperCase()} ${g.url.slice(0, 80)}`));

    const idx = await askList('\nAction:', [
      'Add guide',
      'Scrape a guide',
      'Copy AI prompt (prints to stdout)',
      '← Back',
    ]);

    if (idx === 3) break;

    if (idx === 0) {
      const url = await ask('Guide URL: ');
      const gt = await askList('Guide type:', ['web', 'youtube', 'simc']);
      const types = ['web', 'youtube', 'simc'];
      const result = await api('POST', '/api/admin/guides', { spec, url: url.trim(), guide_type: types[gt] });
      console.log('Added:', result.id);
    }

    if (idx === 1) {
      if (guides.length === 0) { console.log('No guides to scrape.'); continue; }
      const i = await askList('Scrape which?', guides.map(g => g.url.slice(0, 60)));
      await api('POST', `/api/admin/guides/${guides[i].id}/scrape`);
      console.log('Scraped successfully.');
    }

    if (idx === 2) {
      const prompt = await api('GET', `/api/admin/guides/${spec}/prompt`);
      console.log('\n── PROMPT START ──────────────────────────────────────────────');
      console.log(typeof prompt === 'string' ? prompt : JSON.stringify(prompt));
      console.log('── PROMPT END ────────────────────────────────────────────────\n');
    }
  }
}

// ── Rulebook section ──────────────────────────────────────────────────────────

async function rulebookMenu(spec) {
  while (true) {
    const rb = await api('GET', `/api/admin/rulebook/${spec}`).catch(() => null);
    console.log(`\n── Rulebook for ${spec} ──────────────────────────────────────`);
    if (rb) {
      console.log(`  Saved: ${rb.saved_at ?? 'unknown'} | Guides: ${rb.guide_count ?? 'n/a'}`);
      console.log(`  Major CDs: ${rb.major_cooldowns?.length ?? 0} | Rules: ${rb.rules?.length ?? 0}`);
    } else {
      console.log('  No rulebook saved yet.');
    }

    const idx = await askList('\nAction:', [
      'Copy AI prompt (prints to stdout)',
      'Paste AI JSON output → save rulebook',
      '← Back',
    ]);

    if (idx === 2) break;

    if (idx === 0) {
      const prompt = await api('GET', `/api/admin/guides/${spec}/prompt`);
      console.log('\n── PROMPT START ──────────────────────────────────────────────');
      console.log(typeof prompt === 'string' ? prompt : JSON.stringify(prompt));
      console.log('── PROMPT END ────────────────────────────────────────────────\n');
    }

    if (idx === 1) {
      console.log('Paste the AI JSON output (then press Enter twice + Ctrl+D):');
      let json = '';
      rl.on('line', line => json += line + '\n');
      await new Promise(resolve => rl.once('close', resolve));
      try {
        const parsed = JSON.parse(json.trim());
        await api('PUT', `/api/admin/rulebook/${spec}`, parsed);
        console.log('Rulebook saved.');
      } catch (e) {
        console.error('Failed to parse JSON:', e.message);
      }
      return; // rl closed
    }
  }
}

// ── Parses section ────────────────────────────────────────────────────────────

async function parsesMenu(spec) {
  while (true) {
    const idx = await askList(`\n── Parses for ${spec} ────────────────────────────────────────\nAction:`, [
      'Ingest all bosses (streams progress)',
      'View encounter list',
      '← Back',
    ]);

    if (idx === 2) break;

    if (idx === 1) {
      const encs = await api('GET', `/api/admin/encounters`).catch(() => []);
      encs.forEach(e => console.log(`  ${e.id}: ${e.name} — ${e.sample_count ?? 0} samples`));
    }

    if (idx === 0) {
      console.log(`\nIngesting all bosses for ${spec}... (this may take a few minutes)\n`);
      const res = await fetch(`${BASE}/api/admin/parses/ingest-all-stream/${spec}`);
      if (!res.ok) { console.error('Failed:', res.status); continue; }
      for await (const chunk of res.body) {
        const text = new TextDecoder().decode(chunk);
        for (const line of text.split('\n')) {
          const trimmed = line.trim();
          if (trimmed.startsWith('data:')) {
            try {
              const d = JSON.parse(trimmed.slice(5));
              if (d.status) process.stdout.write(`\r${d.name ?? ''}: ${d.status} (${d.done ?? 0}/${d.total ?? '?'})`);
              if (d.done === d.total) console.log(' ✓');
            } catch { /* non-JSON SSE */ }
          }
        }
      }
      console.log('\nDone!');
    }
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const arg = process.argv[2];
  console.log('Warcraft Learner Admin CLI');
  console.log(`Backend: ${BASE}\n`);

  // Test connection
  const ok = await fetch(`${BASE}/`).then(r => r.ok).catch(() => false);
  if (!ok) {
    console.error(`Cannot reach backend at ${BASE}`);
    console.error('Start the server: python3 -m uvicorn main:app --port 8000');
    process.exit(1);
  }

  if (arg === 'guides' || arg === 'parses' || arg === 'rulebook') {
    const spec = await pickSpec();
    if (arg === 'guides') await guidesMenu(spec);
    else if (arg === 'parses') await parsesMenu(spec);
    else if (arg === 'rulebook') await rulebookMenu(spec);
    rl.close();
    return;
  }

  // Interactive main menu
  while (true) {
    const spec = await pickSpec();
    const section = await askList(`\nSection for ${spec}:`, ['Guides', 'Rulebook', 'Parses', 'Exit']);
    if (section === 3) break;
    if (section === 0) await guidesMenu(spec);
    if (section === 1) await rulebookMenu(spec);
    if (section === 2) await parsesMenu(spec);
  }

  rl.close();
}

main().catch(err => { console.error(err.message); process.exit(1); });
