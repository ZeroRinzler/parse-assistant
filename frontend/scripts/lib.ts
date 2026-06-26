/**
 * warcraft-learner - shared CLI helpers
 *
 * Pure Node, no dependencies. Used by the ingestion orchestrator, build-rulebook.ts, and
 * scrape-guides.ts so the JSON I/O, spec discovery, and interactive prompt code lives in one place.
 */

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';
import Ajv from 'ajv';

/** Max guide content length fed into the LLM prompt (admin) and stored per guide (scrape). */
export const MAX_GUIDE_CHARS: number = 60_000;

export async function readJson<T = unknown>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fsp.readFile(filePath, 'utf8')) as T;
  } catch {
    // Missing file (ENOENT) or unparseable content both resolve to null - same
    // contract as the previous existsSync + readFileSync implementation.
    return null;
  }
}

export async function writeJson(filePath: string, data: unknown, compact = false): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, JSON.stringify(data, null, compact ? 0 : 2), 'utf8');
}

// ── Rulebook schema validation ─────────────────────────────────────────────────
//
// One shared validator for prompts/rulebook.schema.json, used by both admin (before
// saving a pasted rulebook) and ingest (pre-flight before consuming a rulebook).
// ajv draft-07; strict:false silences warnings about the draft-2019 $defs/examples
// annotation keywords, which ajv still resolves correctly.

const SCHEMA_PATH = path.resolve(
  fileURLToPath(import.meta.url), '..', '..', '..', 'prompts', 'rulebook.schema.json',
);

let _validator: ReturnType<Ajv['compile']> | null = null;

/** Read the raw rulebook schema text (used by admin to build the LLM prompt). */
export async function readRulebookSchemaText(): Promise<string> {
  return fsp.readFile(SCHEMA_PATH, 'utf8');
}

/**
 * Validate a value against the rulebook schema. Returns an array of human-readable,
 * property-level error strings (empty array = valid). The compiled validator is
 * cached after first use.
 */
export async function validateRulebook(value: unknown): Promise<string[]> {
  if (!_validator) {
    const schema = JSON.parse(await readRulebookSchemaText()) as Record<string, unknown>;
    _validator = new Ajv({ allErrors: true, strict: false }).compile(schema);
  }
  if (_validator(value)) return [];
  return (_validator.errors ?? []).map(e => `${e.instancePath || '(root)'} ${e.message}`);
}

/**
 * List spec folders under `dataDir`. When `requireRulebook` is set, only folders
 * that contain a rulebook.json are returned (ingest's stricter view).
 */
export function getKnownSpecs(dataDir: string, { requireRulebook = false }: { requireRulebook?: boolean } = {}): string[] {
  if (!fs.existsSync(dataDir)) return [];
  return fs.readdirSync(dataDir).filter(name => {
    try {
      if (!fs.statSync(path.join(dataDir, name)).isDirectory()) return false;
      return requireRulebook ? fs.existsSync(path.join(dataDir, name, 'rulebook.json')) : true;
    } catch { return false; }
  }).sort();
}

/** Create a readline interface plus `ask`/`askList` prompt helpers for an interactive CLI. */
export function createPrompt(): {
  rl: readline.Interface;
  ask: (prompt: string) => Promise<string>;
  askList: (prompt: string, choices: string[]) => Promise<number>;
} {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const ask = (prompt: string): Promise<string> => new Promise(resolve => rl.question(prompt, resolve));

  async function askList(prompt: string, choices: string[]): Promise<number> {
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
