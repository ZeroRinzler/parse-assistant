/**
 * Load layer - all filesystem IO under data/specs/**.
 *
 * Reads/writes parse samples, position timelines, encounter bench files, the
 * per-spec encounter index, and the top-level spec index; also reads rulebooks
 * (which drive analysis). The Transform layer (analysis/**) computes the bench
 * payload - this layer only persists it. The only WCL access is delegated to
 * getEnchantNames for enchant-name backfill.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { readJson, writeJson, getKnownSpecs as listSpecs } from '../lib.ts';
import { logWarn } from '../../src/app/core/log.ts';
import { buildEncounterBench } from './analysis/bench.ts';
import { POSITIONS_INTERVAL_S } from './analysis/positions.ts';
import { getEnchantNames } from './wcl-fetchers.ts';
import type { WclQueryClient } from './wcl-client.ts';
import type { Rulebook, RulebookCooldown, RulebookDefensive } from '../../src/app/core/models/rulebook.models.ts';
import type { ParsePositions, EncounterPositions } from '../../src/app/core/models/positioning.models.ts';
import type { ParseCooldownData, ParseSample } from './models/parse-sample.models.ts';
import type { IngestEncounter } from './models/wcl.models.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FRONTEND_ROOT = path.resolve(__dirname, '..', '..');
// WL_DATA_DIR lets a test/dry run write elsewhere instead of the committed data dir.
export const DATA_DIR = process.env['WL_DATA_DIR'] ?? path.join(FRONTEND_ROOT, 'public', 'data', 'specs');
// Ingest only manages specs that already have a rulebook to drive analysis.
export const getKnownSpecs = (): string[] => listSpecs(DATA_DIR, { requireRulebook: true });

// Every ingestion source file (excluding tests + the test toolkit), so any change
// to ETL logic - in any module, not just this one - invalidates cached samples and
// forces re-analysis on the next run.
function collectEtlSources(): string[] {
  const files = [path.join(FRONTEND_ROOT, 'scripts', 'ingest.ts')];
  const walk = (dir: string): void => {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) {
        if (name !== 'testing') walk(full);
      } else if (name.endsWith('.ts') && !name.endsWith('.spec.ts')) {
        files.push(full);
      }
    }
  };
  walk(__dirname);
  return files.sort();
}

export const INGEST_HASH = crypto.createHash('sha256')
  .update(collectEtlSources().map(file => fs.readFileSync(file, 'utf8')).join('\n'))
  .digest('hex')
  .slice(0, 12);

// ── Path helpers ────────────────────────────────────────────────────────────

function nowUtc(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

export function getSamplesPath(spec: string, encounterId: number): string {
  return path.join(DATA_DIR, spec, 'parse_samples', `${encounterId}.json`);
}

export function parseKey(reportCode: string, fightId: number, hash = INGEST_HASH): string {
  return `${reportCode}:${fightId}:${hash}`;
}

function getEncounterPath(spec: string, encounterId: number): string {
  return path.join(DATA_DIR, spec, 'encounters', `${encounterId}.json`);
}

function getPositionsPath(spec: string, encounterId: number): string {
  return path.join(DATA_DIR, spec, 'positions', `${encounterId}.json`);
}

// ── Rulebook reads ────────────────────────────────────────────────────────────

export async function loadRulebook(spec: string): Promise<Rulebook | null> {
  return readJson<Rulebook>(path.join(DATA_DIR, spec, 'rulebook.json'));
}

export async function getSpecCooldowns(spec: string): Promise<RulebookCooldown[] | null> {
  const rulebook = await loadRulebook(spec);
  return rulebook?.major_cooldowns?.length ? rulebook.major_cooldowns : null;
}

export async function getSpecDefensives(spec: string): Promise<RulebookDefensive[]> {
  const rulebook = await loadRulebook(spec);
  return rulebook?.defensives?.length ? rulebook.defensives : [];
}

// ── Sample / position reads + writes ─────────────────────────────────────────

/** Read the raw parse samples for an encounter (empty array when none exist). */
export async function readSamples(spec: string, encounterId: number): Promise<ParseSample[]> {
  return await readJson<ParseSample[]>(getSamplesPath(spec, encounterId)) ?? [];
}

/** Append a parse's position timelines (deduped by report+fight) to the positions file. */
export async function savePositions(spec: string, encounterId: number, encounterName: string, positions: ParsePositions | null): Promise<void> {
  if (!positions) return;
  const file = getPositionsPath(spec, encounterId);
  const existing = await readJson<EncounterPositions>(file) ?? {};
  let parses = Array.isArray((existing as EncounterPositions).parses) ? (existing as EncounterPositions).parses : [];
  parses = parses.filter(parse => !(parse.report_code === positions.report_code && parse.fight_id === positions.fight_id));
  parses.push(positions);
  await writeJson(file, {
    spec, encounter_id: encounterId, encounter_name: encounterName,
    interval_s: POSITIONS_INTERVAL_S, sample_count: parses.length, parses,
  }, true);
}

export async function saveParseSample(
  spec: string, encounterId: number, encounterName: string,
  reportCode: string, fightId: number, playerName: string, cooldownData: ParseCooldownData,
): Promise<void> {
  const samplesPath = getSamplesPath(spec, encounterId);
  let samples = await readJson<ParseSample[]>(samplesPath) ?? [];
  samples = samples.filter(sample => !(sample.report_code === reportCode && sample.fight_id === fightId));
  samples.push({
    spec, encounter_id: encounterId, encounter_name: encounterName,
    report_code: reportCode, fight_id: fightId, player_name: playerName,
    sampled_at: nowUtc(), ingest_hash: INGEST_HASH, cooldown_data: cooldownData,
  });
  await writeJson(samplesPath, samples);
}

// ── Encounter bench / index aggregation ──────────────────────────────────────

// Read samples -> compute bench (pure, in analysis/bench) -> write the encounter
// file and refresh the per-spec encounter index.
export async function syncEncounterFile(spec: string, encounterId: number): Promise<void> {
  const samples = await readSamples(spec, encounterId);
  if (!samples.length) return;

  const specDefensives = await getSpecDefensives(spec);
  const bench = buildEncounterBench(samples, specDefensives, spec, encounterId);

  await writeJson(getEncounterPath(spec, encounterId), bench);
  await syncEncountersIndex(spec);
}

async function syncEncountersIndex(spec: string): Promise<void> {
  const encDir = path.join(DATA_DIR, spec, 'encounters');
  if (!fs.existsSync(encDir)) return;
  const entries: Array<{ id: number; name: string; sample_count: number }> = [];
  for (const file of fs.readdirSync(encDir).sort()) {
    if (!file.endsWith('.json')) continue;
    try {
      const data = await readJson<{ encounter_id?: number; encounter_name?: string; sample_count?: number }>(path.join(encDir, file)) ?? {};
      entries.push({
        id: data.encounter_id ?? parseInt(file),
        name: data.encounter_name ?? file,
        sample_count: data.sample_count ?? 0,
      });
    } catch (err) {
      logWarn(`syncEncountersIndex ${spec}/${file}`, err);
    }
  }
  await writeJson(path.join(DATA_DIR, spec, 'encounters.json'), entries);
}

/** Rebuild data/specs/index.json by scanning all spec folders on disk. */
export async function writeSpecIndex(): Promise<void> {
  if (!fs.existsSync(DATA_DIR)) return;
  const entries: Array<{ spec: string; encounter_count: number }> = [];
  for (const spec of fs.readdirSync(DATA_DIR).sort()) {
    const encFile = path.join(DATA_DIR, spec, 'encounters.json');
    if (!fs.existsSync(encFile)) continue;
    try {
      const encounters = await readJson<Array<{ sample_count?: number }>>(encFile) ?? [];
      const count = encounters.filter(encounter => encounter.sample_count && encounter.sample_count > 0).length;
      if (count > 0) entries.push({ spec, encounter_count: count });
    } catch (err) {
      logWarn(`writeSpecIndex ${spec}`, err);
    }
  }
  await writeJson(path.join(DATA_DIR, 'index.json'), entries);
}

// Delete on-disk data for encounters that are no longer current. An encounter is
// stale when its id is absent from `protectedIds` (every non-frozen current-expansion
// encounter id - see protectedEncounterIds). For each stale id in each spec we remove
// the encounter bench, parse samples, and position timeline, then rebuild the indexes.
//
// Safety: an empty `protectedIds` almost always means the worldData fetch transiently
// failed, not that all content is gone, so we never prune in that case. Because the
// protected set is every non-frozen current-expansion id (wider than the ingested set),
// a live raid that briefly fails its liveness probe is never wiped; an encounter only
// becomes prunable once WCL freezes its zone or it leaves the current expansion.
export async function pruneStaleEncounters(protectedIds: Set<number>): Promise<{ removed: number[] }> {
  const removed = new Set<number>();
  if (!fs.existsSync(DATA_DIR)) return { removed: [] };
  if (protectedIds.size === 0) {
    logWarn('pruneStaleEncounters', 'empty protected set - skipping prune (likely a transient WCL failure)');
    return { removed: [] };
  }

  const touchedSpecs = new Set<string>();
  for (const spec of fs.readdirSync(DATA_DIR).sort()) {
    const encDir = path.join(DATA_DIR, spec, 'encounters');
    if (!fs.existsSync(encDir)) continue;
    for (const file of fs.readdirSync(encDir).sort()) {
      if (!file.endsWith('.json')) continue;
      const encounterId = parseInt(file);
      if (!Number.isFinite(encounterId) || protectedIds.has(encounterId)) continue;
      removed.add(encounterId);
      touchedSpecs.add(spec);
      for (const stalePath of [getEncounterPath(spec, encounterId), getSamplesPath(spec, encounterId), getPositionsPath(spec, encounterId)]) {
        try {
          fs.rmSync(stalePath, { force: true });
        } catch (err) {
          logWarn(`pruneStaleEncounters ${spec}/${encounterId}`, err);
        }
      }
    }
  }

  for (const spec of touchedSpecs) await syncEncountersIndex(spec);
  if (touchedSpecs.size) await writeSpecIndex();
  return { removed: [...removed].sort((a, b) => a - b) };
}

// ── Enchant name resolution ───────────────────────────────────────────────────

// Patches missing enchant names in an already-written encounter bench file: find
// the empty-name enchant IDs, resolve them via WCL (getEnchantNames), patch, and
// rewrite. No-ops when nothing is missing or nothing resolved.
export async function resolveEnchantNames(client: WclQueryClient, spec: string, encounterId: number): Promise<void> {
  const encPath = getEncounterPath(spec, encounterId);
  type EncFile = { gear: { enchants: Record<string, Array<{ id: number | string; name: string }>> } };
  const data = await readJson<EncFile>(encPath);
  if (!data?.gear?.enchants) return;

  const enchantsMap = data.gear.enchants;
  const toResolve = new Map<number | string, Array<{ slot: string; idx: number }>>();
  for (const [slot, items] of Object.entries(enchantsMap)) {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.id && !item.name) {
        if (!toResolve.has(item.id)) toResolve.set(item.id, []);
        toResolve.get(item.id)!.push({ slot, idx: i });
      }
    }
  }
  if (!toResolve.size) return;

  const names = await getEnchantNames(client, [...toResolve.keys()]);
  let patched = false;
  for (const [id, locations] of toResolve.entries()) {
    const name = names.get(id);
    if (!name) continue;
    for (const { slot, idx } of locations) {
      enchantsMap[slot][idx].name = name;
      patched = true;
    }
  }
  if (patched) await writeJson(encPath, data);
}

// ── Spec selection ────────────────────────────────────────────────────────────

// Returns known specs (those with a rulebook.json) sorted most-stale-first.
export async function specsByStaleness(encounters: IngestEncounter[]): Promise<string[]> {
  const now = Date.now();
  const known = getKnownSpecs();
  // Precompute staleness per spec (async IO) before the synchronous sort.
  const scores = new Map<string, number>(
    await Promise.all(known.map(async spec => [spec, await staleness(spec, encounters, now)] as const)),
  );
  return known.slice().sort((a, b) => (scores.get(a) ?? 0) - (scores.get(b) ?? 0));
}

// INVARIANT: callers MUST pass the live encounter set (the probe-confirmed current
// raids). A never-ingested encounter here is intentionally treated as maximally stale
// so its spec sorts first. This is only correct because the input contains no
// permanently-unfetchable bosses - feeding it beta/PTR encounters (which never produce
// samples) would pin every spec to Infinity and destroy the ordering.
async function staleness(spec: string, encounters: IngestEncounter[], now: number): Promise<number> {
  let worst = 0;
  for (const encounter of encounters) {
    const samples = await readSamples(spec, encounter.id);
    if (!samples.length) return Infinity; // never ingested
    const newestMs = Math.max(...samples.map(sample => new Date(sample.sampled_at ?? 0).getTime()));
    const ageMs = now - newestMs;
    if (ageMs > worst) worst = ageMs;
  }
  return worst;
}
