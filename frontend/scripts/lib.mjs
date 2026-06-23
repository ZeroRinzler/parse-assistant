/**
 * warcraft-learner - shared CLI helpers
 *
 * Pure Node, no dependencies. Used by ingest.mjs, admin.mjs, and scrape.mjs so
 * the JSON I/O, spec discovery, and interactive prompt code lives in one place.
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';

/** Max guide content length fed into the LLM prompt (admin) and stored per guide (scrape). */
export const MAX_GUIDE_CHARS = 60_000;

export function readJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return null; }
}

export function writeJson(filePath, data, compact = false) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, compact ? 0 : 2), 'utf8');
}

/**
 * List spec folders under `dataDir`. When `requireRulebook` is set, only folders
 * that contain a rulebook.json are returned (ingest's stricter view).
 */
export function getKnownSpecs(dataDir, { requireRulebook = false } = {}) {
  if (!fs.existsSync(dataDir)) return [];
  return fs.readdirSync(dataDir).filter(name => {
    try {
      if (!fs.statSync(path.join(dataDir, name)).isDirectory()) return false;
      return requireRulebook ? fs.existsSync(path.join(dataDir, name, 'rulebook.json')) : true;
    } catch { return false; }
  }).sort();
}

/** Create a readline interface plus `ask`/`askList` prompt helpers for an interactive CLI. */
export function createPrompt() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const ask = prompt => new Promise(resolve => rl.question(prompt, resolve));

  async function askList(prompt, choices) {
    const lines = choices.map((choice, i) => `  [${i + 1}] ${choice}`).join('\n');
    while (true) {
      const answer = await ask(`${prompt}\n${lines}\n> `);
      const n = parseInt(answer);
      if (n >= 1 && n <= choices.length) return n - 1;
      console.log('Invalid choice, try again.');
    }
  }

  return { rl, ask, askList };
}
