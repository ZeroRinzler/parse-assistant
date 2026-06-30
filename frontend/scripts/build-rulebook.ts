#!/usr/bin/env node
/**
 * warcraft-learner - Rulebook Builder CLI
 *
 * Manages AI-generated rulebooks for specs.
 * Reads scraped guides from frontend/public/data/specs/{spec}/guides.json,
 * builds the LLM prompt, and writes the pasted AI output directly to
 * frontend/public/data/specs/{spec}/rulebook.json - no server needed.
 *
 * Usage:
 *   npm run rulebook
 *
 * Related scripts:
 *   npm run scrape   - add and scrape guide URLs
 *   npm run ingest   - ingest top WCL parses
 */

import fs from 'fs';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { Command } from 'commander';
import type { Rulebook } from '../src/app/core/models/rulebook.models.ts';
import { MAX_GUIDE_CHARS, readJson, writeJson, getKnownSpecs as listSpecs, createPrompt, readRulebookSchemaText, validateRulebook } from './lib.ts';

new Command()
  .name('rulebook')
  .description('Manage AI-generated rulebooks for specs (interactive).')
  .addHelpText('after', '\nRelated:\n  npm run scrape   - add and scrape guide URLs\n  npm run ingest   - ingest top WCL parses')
  .parse(process.argv);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FRONTEND_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(FRONTEND_ROOT, 'public', 'data', 'specs');
const RULEBOOK_SKILL_DIR = path.resolve(__dirname, '..', '..', '.claude', 'skills', 'warcraft-ingestion');

const { rl, ask, askList } = createPrompt();
const getKnownSpecs = (): string[] => listSpecs(DATA_DIR);

// ── Clipboard ────────────────────────────────────────────────────────────────

function trySpawnSync(cmd: string, args: string[], input: string): boolean {
  const r = spawnSync(cmd, args, { input, encoding: 'utf8', timeout: 3000 });
  return r.status === 0 && !r.error;
}

// wl-copy stays running as a clipboard provider (Wayland design) - must be detached
function wlCopy(text: string): Promise<boolean> {
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

async function copyToClipboard(text: string): Promise<boolean> {
  if (process.platform === 'darwin') {
    return trySpawnSync('pbcopy', [], text);
  }
  if (process.platform === 'win32') {
    return trySpawnSync('clip', [], text);
  }
  // Linux - try Wayland then X11
  const isWayland = !!process.env.WAYLAND_DISPLAY;
  if (isWayland && await wlCopy(text)) return true;
  if (trySpawnSync('xclip', ['-selection', 'clipboard'], text)) return true;
  if (trySpawnSync('xsel', ['--clipboard', '--input'], text)) return true;
  if (!isWayland && await wlCopy(text)) return true;
  return false;
}

// ── Prompt building ───────────────────────────────────────────────────────────

interface GuideEntry {
  status: string;
  content?: string;
  guide_type: string;
  url: string;
}

async function buildPrompt(spec: string): Promise<string> {
  const skillPath = path.join(RULEBOOK_SKILL_DIR, 'rulebook_skill.md');
  if (!fs.existsSync(skillPath)) throw new Error(`Skill file not found: ${skillPath}`);

  const schemaText = await readRulebookSchemaText();

  let skill = fs.readFileSync(skillPath, 'utf8');
  skill = skill.replace(/\{\{spec\}\}/g, spec);
  skill = skill.replace(/\{\{schema\}\}/g, () => schemaText.trim());

  const guidesPath = path.join(DATA_DIR, spec, 'guides.json');
  const guides = await readJson<GuideEntry[]>(guidesPath) ?? [];
  const scraped = guides.filter(g => g.status === 'scraped' && g.content);

  if (!scraped.length) {
    throw new Error(`No scraped guides found for ${spec}. Run "npm run scrape" first.`);
  }

  const sections = scraped.map((g, i) =>
    `--- Guide ${i + 1} (${g.guide_type}: ${g.url}) ---\n${(g.content ?? '').slice(0, MAX_GUIDE_CHARS)}`
  );

  return `${skill}\n\n## Guide Content\n\n${sections.join('\n\n')}`;
}

// ── Rulebook management ───────────────────────────────────────────────────────

// Reads pasted JSON by accumulating lines until JSON.parse succeeds.
// Reuses the existing rl interface so the menu stays alive after pasting.
function readJsonPaste(): Promise<string> {
  console.log('Paste the JSON output (auto-detects when complete):\n');
  return new Promise(resolve => {
    const lines: string[] = [];
    const onLine = (line: string): void => {
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

async function rulebookMenu(spec: string): Promise<void> {
  while (true) {
    const rbPath = path.join(DATA_DIR, spec, 'rulebook.json');
    const rb = await readJson<Rulebook>(rbPath);

    console.log(`\n-- Rulebook for ${spec} ------------------------------------------------`);
    if (rb) {
      console.log(`  Saved: ${rb.saved_at ?? 'unknown'} | Guides used: ${rb.guide_count ?? 'n/a'}`);
      console.log(`  Major CDs: ${rb.major_cooldowns?.length ?? 0} | Defensives: ${rb.defensives?.length ?? 0} | Rules: ${rb.rules?.length ?? 0}`);
    } else {
      console.log('  No rulebook saved yet.');
    }

    const idx = await askList('\nAction:', [
      'Print AI prompt (copy-paste into your LLM)',
      'Paste AI JSON output -> save rulebook',
      '<- Back',
    ]);

    if (idx === 2) break;

    if (idx === 0) {
      let prompt: string;
      try {
        prompt = await buildPrompt(spec);
      } catch (err) {
        console.error(`\nError: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      const copied = await copyToClipboard(prompt);
      if (copied) {
        console.log(`\nPrompt copied to clipboard (${prompt.length.toLocaleString()} chars). Paste it into your LLM.\n`);
      } else {
        console.log('\n== PROMPT START (copy everything below this line) ===================\n');
        console.log(prompt);
        console.log('\n== PROMPT END ======================================================\n');
        const hint = process.platform === 'linux'
          ? '  Install clipboard support: sudo dnf install wl-clipboard   (Fedora/Wayland)\n  or: sudo apt install xclip   (Debian/Ubuntu)'
          : '';
        console.log(`Could not copy automatically - clipboard tool not found.\n${hint}\n`);
      }
    }

    if (idx === 1) {
      const json = await readJsonPaste();
      try {
        const parsed = JSON.parse(json) as Record<string, unknown>;
        if (!parsed['spec']) parsed['spec'] = spec;

        const errors = await validateRulebook(parsed);
        if (errors.length) {
          console.error(`\nPasted JSON failed schema validation (${errors.length} error(s)):`);
          errors.slice(0, 20).forEach(e => console.error(`  - ${e}`));
          if (errors.length > 20) console.error(`  ...and ${errors.length - 20} more`);
          console.error('\nRulebook NOT saved. Fix the issues and paste again.');
          continue;
        }

        const guidesPath = path.join(DATA_DIR, spec, 'guides.json');
        const guides = await readJson<GuideEntry[]>(guidesPath) ?? [];
        const guideCount = guides.filter(g => g.status === 'scraped').length;

        const toSave = {
          ...parsed,
          guide_count: guideCount,
          saved_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
        };

        await writeJson(rbPath, toSave);
        console.log(`\nRulebook saved to ${rbPath}`);
        const savedRb = toSave as Partial<Rulebook>;
        console.log(`  ${savedRb.major_cooldowns?.length ?? 0} cooldowns, ${savedRb.defensives?.length ?? 0} defensives, ${savedRb.rules?.length ?? 0} rules`);
      } catch (err) {
        console.error(`\nFailed to parse JSON: ${err instanceof Error ? err.message : String(err)}`);
        console.error('Make sure you pasted the raw JSON object (starting with {, ending with }).');
      }
      continue;
    }
  }
}

// ── Spec selection ────────────────────────────────────────────────────────────

async function pickSpec(): Promise<string> {
  const specs = getKnownSpecs();
  console.log('\nKnown specs in data/specs/:');
  if (specs.length) specs.forEach((s, i) => console.log(`  [${i + 1}] ${s}`));
  else console.log('  (none yet - run "npm run scrape" to add guides for a spec)');
  const raw = await ask('\nEnter spec name or number (e.g. SubtletyRogue): ');
  const n = parseInt(raw);
  if (n >= 1 && n <= specs.length) return specs[n - 1];
  return raw.trim();
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('warcraft-learner - Rulebook Admin');
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

// Only run the interactive CLI when invoked directly (not when imported, e.g. by tests).
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch(err => {
    console.error('\nFatal error:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}

export { buildPrompt };
export { validateRulebook } from './lib.ts';
