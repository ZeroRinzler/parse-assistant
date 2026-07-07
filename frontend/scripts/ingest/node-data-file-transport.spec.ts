import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { FsDataFileTransport } from './node-data-file-transport.ts';
import { INGEST_VERSION } from './ingest-version.ts';
import { ok, missing } from '../../src/app/core/result.ts';

// A relative path that climbs out of the data root: the exact shape the containment check must reject.
const TRAVERSAL_PATH = '../escapes.json';
const NESTED_TRAVERSAL_PATH = 'spec/../../escapes.json';
const SAFE_REL_PATH = 'AssassinationRogue/rotation/2900.json';
const MISSING_REL_PATH = 'AssassinationRogue/rotation/does-not-exist.json';
const MISSING_DIR = 'AssassinationRogue/no-such-dir';
const PAYLOAD = { value: 42 };
const ESCAPE_ERROR = /escapes data root/;

describe('FsDataFileTransport', () => {
  let root: string;
  let transport: FsDataFileTransport;

  beforeEach(async () => {
    root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wl-transport-'));
    transport = new FsDataFileTransport(root);
  });

  afterEach(async () => {
    await fs.promises.rm(root, { recursive: true, force: true });
  });

  it('round-trips JSON written inside the root, resolving ok(body)', async () => {
    await transport.writeJson(SAFE_REL_PATH, PAYLOAD);
    expect(await transport.readJson(SAFE_REL_PATH)).toEqual(ok(PAYLOAD));
  });

  it('resolves missing for a missing file (ENOENT-tolerant read)', async () => {
    expect(await transport.readJson(MISSING_REL_PATH)).toEqual(missing('Not yet ingested.'));
  });

  it('resolves permanent for a file stamped with a newer ingest version (schema guard)', async () => {
    await transport.writeJson(SAFE_REL_PATH, { ...PAYLOAD, ingest_version: INGEST_VERSION + 1 });
    const result = await transport.readJson(SAFE_REL_PATH);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('permanent');
  });

  it('reads a file stamped at the current ingest version normally', async () => {
    const body = { ...PAYLOAD, ingest_version: INGEST_VERSION };
    await transport.writeJson(SAFE_REL_PATH, body);
    expect(await transport.readJson(SAFE_REL_PATH)).toEqual(ok(body));
  });

  it('leaves no temp file behind after an atomic write', async () => {
    await transport.writeJson(SAFE_REL_PATH, PAYLOAD);
    const dir = path.join(root, path.dirname(SAFE_REL_PATH));
    const entries = await fs.promises.readdir(dir);
    expect(entries).toEqual([path.basename(SAFE_REL_PATH)]);
  });

  it('returns an empty list for a missing directory (ENOENT-tolerant list)', async () => {
    expect(await transport.list(MISSING_DIR)).toEqual([]);
  });

  it('contains a read that escapes the data root with `..`, resolving permanent', async () => {
    const result = await transport.readJson(TRAVERSAL_PATH);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('permanent');
      if (result.error.kind === 'permanent') expect((result.error.context as Error).message).toMatch(ESCAPE_ERROR);
    }
  });

  it('contains a nested `..` read sequence that resolves outside the root, resolving permanent', async () => {
    const result = await transport.readJson(NESTED_TRAVERSAL_PATH);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('permanent');
  });

  it('rejects a write that escapes the data root', async () => {
    await expect(transport.writeJson(TRAVERSAL_PATH, PAYLOAD)).rejects.toThrow(ESCAPE_ERROR);
  });

  it('rejects a remove that escapes the data root', async () => {
    await expect(transport.remove(TRAVERSAL_PATH)).rejects.toThrow(ESCAPE_ERROR);
  });

  it('rejects a list that escapes the data root', async () => {
    await expect(transport.list('..')).rejects.toThrow(ESCAPE_ERROR);
  });

  it('allows the root itself (relPath resolving exactly to root)', async () => {
    expect(await transport.list('')).toEqual([]);
  });
});
