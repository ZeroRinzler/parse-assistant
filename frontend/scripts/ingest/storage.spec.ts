import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  DATA_DIR, saveParseSample, readSamples, savePositions, syncEncounterFile,
  writeSpecIndex, resolveEnchantNames, specsByStaleness,
} from './storage.ts';
import { sample } from './testing/samples.ts';
import type { WclQueryClient } from './wcl-client.ts';
import type { ParsePositions } from '../../src/app/core/models/positioning.models.ts';
import type { IngestEncounter } from './models/wcl.models.ts';

function readJsonFile<T>(...segments: string[]): T {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, ...segments), 'utf8')) as T;
}

function writeRulebook(spec: string): void {
  fs.mkdirSync(path.join(DATA_DIR, spec), { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, spec, 'rulebook.json'), JSON.stringify({ spec, major_cooldowns: [], defensives: [], rules: [] }));
}

const cooldownData = sample().cooldown_data;

beforeEach(() => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
});

describe('saveParseSample / readSamples', () => {
  it('round-trips, dedupes by report+fight, and stamps the ingest hash', async () => {
    await saveParseSample('SpecA', 100, 'Boss', 'rep1', 1, 'P1', cooldownData);
    let samples = await readSamples('SpecA', 100);
    expect(samples).toHaveLength(1);
    expect(samples[0].ingest_hash).toBeTruthy();
    expect(samples[0].sampled_at).toBeTruthy();

    // Same report+fight replaces (no duplicate).
    await saveParseSample('SpecA', 100, 'Boss', 'rep1', 1, 'P1b', cooldownData);
    samples = await readSamples('SpecA', 100);
    expect(samples).toHaveLength(1);
    expect(samples[0].player_name).toBe('P1b');

    // Different fight appends.
    await saveParseSample('SpecA', 100, 'Boss', 'rep1', 2, 'P2', cooldownData);
    expect(await readSamples('SpecA', 100)).toHaveLength(2);
  });

  it('returns [] when no samples file exists', async () => {
    expect(await readSamples('Nope', 1)).toEqual([]);
  });
});

describe('savePositions', () => {
  const positions: ParsePositions = {
    report_code: 'rep1', fight_id: 1, player_name: 'P', duration_s: 60, interval_s: 1.5,
    player: [[0, 0, 0, null, null]], enemies: [],
  };

  it('dedupes by report+fight and is a no-op for null', async () => {
    await savePositions('SpecA', 100, 'Boss', positions);
    await savePositions('SpecA', 100, 'Boss', { ...positions }); // same report+fight
    await savePositions('SpecA', 100, 'Boss', null);
    const file = readJsonFile<{ sample_count: number; parses: unknown[] }>('SpecA', 'positions', '100.json');
    expect(file.sample_count).toBe(1);
    expect(file.parses).toHaveLength(1);
  });
});

describe('syncEncounterFile + writeSpecIndex', () => {
  it('writes the bench file, refreshes the encounter index, and lists the spec', async () => {
    writeRulebook('SpecB');
    await saveParseSample('SpecB', 200, 'Boss2', 'r', 1, 'P', cooldownData);
    await syncEncounterFile('SpecB', 200);

    const bench = readJsonFile<{ sample_count: number; encounter_name: string }>('SpecB', 'encounters', '200.json');
    expect(bench.sample_count).toBe(1);
    expect(bench.encounter_name).toBe('Boss2'); // from the encounterName passed to saveParseSample

    const index = readJsonFile<Array<{ id: number; name: string; sample_count: number }>>('SpecB', 'encounters.json');
    expect(index).toContainEqual({ id: 200, name: 'Boss2', sample_count: 1 });

    await writeSpecIndex();
    const specIndex = readJsonFile<Array<{ spec: string; encounter_count: number }>>('index.json');
    expect(specIndex).toContainEqual({ spec: 'SpecB', encounter_count: 1 });
  });
});

describe('resolveEnchantNames', () => {
  it('backfills empty enchant names from the WCL lookup', async () => {
    const encDir = path.join(DATA_DIR, 'SpecC', 'encounters');
    fs.mkdirSync(encDir, { recursive: true });
    fs.writeFileSync(path.join(encDir, '300.json'), JSON.stringify({ gear: { enchants: { '15': [{ id: 200, name: '' }] } } }));

    const client = { async query() { return { gameData: { e200: { id: 200, name: 'Enchant A' } } }; } } as unknown as WclQueryClient;
    await resolveEnchantNames(client, 'SpecC', 300);

    const patched = readJsonFile<{ gear: { enchants: Record<string, Array<{ name: string }>> } }>('SpecC', 'encounters', '300.json');
    expect(patched.gear.enchants['15'][0].name).toBe('Enchant A');
  });
});

describe('specsByStaleness', () => {
  const encounters: IngestEncounter[] = [{ id: 100, name: 'Boss', zone: 'z', expansion: 'e', partitionIds: [] }];

  it('includes only specs with a rulebook and ranks never-ingested after ingested', async () => {
    writeRulebook('SpecIngested');
    writeRulebook('SpecNever');
    fs.mkdirSync(path.join(DATA_DIR, 'SpecNoRulebook'), { recursive: true }); // no rulebook -> excluded
    await saveParseSample('SpecIngested', 100, 'Boss', 'r', 1, 'P', cooldownData);

    const order = await specsByStaleness(encounters);
    expect(order).toContain('SpecIngested');
    expect(order).toContain('SpecNever');
    expect(order).not.toContain('SpecNoRulebook');
    // never-ingested scores Infinity, so it sorts after the ingested (finite) spec.
    expect(order.indexOf('SpecIngested')).toBeLessThan(order.indexOf('SpecNever'));
  });
});
