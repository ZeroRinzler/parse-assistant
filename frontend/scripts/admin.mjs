#!/usr/bin/env node
/**
 * warcraft-learner — Rulebook Admin CLI
 *
 * Manages AI-generated rulebooks for specs.
 * Reads scraped guides from frontend/public/data/specs/{spec}/guides.json,
 * builds the LLM prompt, and writes the pasted AI output directly to
 * frontend/public/data/specs/{spec}/rulebook.json — no server needed.
 *
 * Usage:
 *   npm run admin
 *   npm run admin -- rulebook   (jump to rulebook menu)
 *
 * Related scripts:
 *   npm run scrape   — add and scrape guide URLs
 *   npm run ingest   — ingest top WCL parses
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FRONTEND_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(FRONTEND_ROOT, 'public', 'data', 'specs');
const PROMPTS_DIR = path.resolve(__dirname, '..', '..', 'prompts');
const MAX_GUIDE_CHARS = 60_000;

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

// ── File I/O ──────────────────────────────────────────────────────────────────

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return null; }
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function getKnownSpecs() {
  if (!fs.existsSync(DATA_DIR)) return [];
  return fs.readdirSync(DATA_DIR).filter(d => {
    try { return fs.statSync(path.join(DATA_DIR, d)).isDirectory(); } catch { return false; }
  }).sort();
}

// ── Clipboard ────────────────────────────────────────────────────────────────

function trySpawnSync(cmd, args, input) {
  const r = spawnSync(cmd, args, { input, encoding: 'utf8', timeout: 3000 });
  return r.status === 0 && !r.error;
}

// wl-copy stays running as a clipboard provider (Wayland design) — must be detached
function wlCopy(text) {
  return new Promise(resolve => {
    try {
      const proc = spawn('wl-copy', [], {
        detached: true,
        stdio: ['pipe', 'ignore', 'ignore'],
      });
      proc.on('error', () => resolve(false));
      proc.stdin.write(text, 'utf8');
      proc.stdin.end();
      proc.unref();
      setTimeout(() => resolve(true), 150);
    } catch {
      resolve(false);
    }
  });
}

async function copyToClipboard(text) {
  if (process.platform === 'darwin') {
    return trySpawnSync('pbcopy', [], text);
  }
  if (process.platform === 'win32') {
    return trySpawnSync('clip', [], text);
  }
  // Linux — try Wayland then X11
  const isWayland = !!process.env.WAYLAND_DISPLAY;
  if (isWayland && await wlCopy(text)) return true;
  if (trySpawnSync('xclip', ['-selection', 'clipboard'], text)) return true;
  if (trySpawnSync('xsel', ['--clipboard', '--input'], text)) return true;
  if (!isWayland && await wlCopy(text)) return true;
  return false;
}

// ── Prompt building ───────────────────────────────────────────────────────────

function buildPrompt(spec) {
  const skillPath = path.join(PROMPTS_DIR, 'rulebook_skill.md');
  if (!fs.existsSync(skillPath)) throw new Error(`Skill file not found: ${skillPath}`);

  let skill = fs.readFileSync(skillPath, 'utf8');
  skill = skill.replace(/\{\{spec\}\}/g, spec);

  const guidesPath = path.join(DATA_DIR, spec, 'guides.json');
  const guides = readJson(guidesPath) || [];
  const scraped = guides.filter(g => g.status === 'scraped' && g.content);

  if (!scraped.length) {
    throw new Error(`No scraped guides found for ${spec}. Run "npm run scrape" first.`);
  }

  const sections = scraped.map((g, i) =>
    `--- Guide ${i + 1} (${g.guide_type}: ${g.url}) ---\n${(g.content || '').slice(0, MAX_GUIDE_CHARS)}`
  );

  return `${skill}\n\n## Guide Content\n\n${sections.join('\n\n')}`;
}

// ── Rulebook management ───────────────────────────────────────────────────────

// Reads pasted JSON by accumulating lines until JSON.parse succeeds.
// Reuses the existing rl interface so the menu stays alive after pasting.
function readJsonPaste() {
  console.log('Paste the JSON output (auto-detects when complete):\n');
  return new Promise(resolve => {
    const lines = [];
    const onLine = line => {
      lines.push(line);
      const acc = lines.join('\n').trim();
      if (acc.startsWith('{') || acc.startsWith('[')) {
        try {
          JSON.parse(acc);
          rl.removeListener('line', onLine);
          resolve(acc);
        } catch { /* keep reading */ }
      }
    };
    rl.on('line', onLine);
  });
}

async function rulebookMenu(spec) {
  while (true) {
    const rbPath = path.join(DATA_DIR, spec, 'rulebook.json');
    const rb = readJson(rbPath);

    console.log(`\n── Rulebook for ${spec} ──────────────────────────────────────`);
    if (rb) {
      console.log(`  Saved: ${rb.saved_at ?? 'unknown'} | Guides used: ${rb.guide_count ?? 'n/a'}`);
      console.log(`  Major CDs: ${rb.major_cooldowns?.length ?? 0} | Defensives: ${rb.defensives?.length ?? 0} | Rules: ${rb.rules?.length ?? 0}`);
    } else {
      console.log('  No rulebook saved yet.');
    }

    const idx = await askList('\nAction:', [
      'Print AI prompt (copy-paste into your LLM)',
      'Paste AI JSON output → save rulebook',
      '← Back',
    ]);

    if (idx === 2) break;

    if (idx === 0) {
      let prompt;
      try {
        prompt = buildPrompt(spec);
      } catch (err) {
        console.error(`\nError: ${err.message}`);
        continue;
      }
      const copied = await copyToClipboard(prompt);
      if (copied) {
        console.log(`\n✓ Prompt copied to clipboard (${prompt.length.toLocaleString()} chars). Paste it into your LLM.\n`);
      } else {
        console.log('\n══ PROMPT START (copy everything below this line) ═══════════\n');
        console.log(prompt);
        console.log('\n══ PROMPT END ═══════════════════════════════════════════════\n');
        const hint = process.platform === 'linux'
          ? '  Install clipboard support: sudo dnf install wl-clipboard   (Fedora/Wayland)\n  or: sudo apt install xclip   (Debian/Ubuntu)'
          : '';
        console.log(`Could not copy automatically — clipboard tool not found.\n${hint}\n`);
      }
    }

    if (idx === 1) {
      const json = await readJsonPaste();
      try {
        const parsed = JSON.parse(json);
        if (!parsed.spec) parsed.spec = spec;

        const guidesPath = path.join(DATA_DIR, spec, 'guides.json');
        const guides = readJson(guidesPath) || [];
        const guideCount = guides.filter(g => g.status === 'scraped').length;

        const toSave = {
          ...parsed,
          guide_count: guideCount,
          saved_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
        };

        writeJson(rbPath, toSave);
        console.log(`\nRulebook saved to ${rbPath}`);
        console.log(`  ${toSave.major_cooldowns?.length ?? 0} cooldowns, ${toSave.defensives?.length ?? 0} defensives, ${toSave.rules?.length ?? 0} rules`);
      } catch (err) {
        console.error(`\nFailed to parse JSON: ${err.message}`);
        console.error('Make sure you pasted the raw JSON object (starting with {, ending with }).');
      }
      continue;
    }
  }
}

// ── Spec selection ────────────────────────────────────────────────────────────

async function pickSpec() {
  const specs = getKnownSpecs();
  console.log('\nKnown specs in data/specs/:');
  if (specs.length) specs.forEach((s, i) => console.log(`  [${i + 1}] ${s}`));
  else console.log('  (none yet — run "npm run scrape" to add guides for a spec)');
  const raw = await ask('\nEnter spec name or number (e.g. SubtletyRogue): ');
  const n = parseInt(raw);
  if (n >= 1 && n <= specs.length) return specs[n - 1];
  return raw.trim();
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const arg = process.argv[2];
  console.log('warcraft-learner — Rulebook Admin');
  console.log('For guides: npm run scrape');
  console.log('For parses: npm run ingest\n');

  while (true) {
    const spec = await pickSpec();
    if (!spec) break;

    await rulebookMenu(spec);

    const again = await ask('\nManage another spec? [y/N] ');
    if (again.trim().toLowerCase() !== 'y') break;
  }

  rl.close();
}

main().catch(err => {
  console.error('\nFatal error:', err.message);
  process.exit(1);
});
