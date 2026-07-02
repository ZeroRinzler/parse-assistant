import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { FsDataFileTransport } from './node-data-file-transport.ts';

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

  it('round-trips JSON written inside the root', async () => {
    await transport.writeJson(SAFE_REL_PATH, PAYLOAD);
    expect(await transport.readJson(SAFE_REL_PATH)).toEqual(PAYLOAD);
  });

  it('returns null for a missing file (ENOENT-tolerant read)', async () => {
    expect(await transport.readJson(MISSING_REL_PATH)).toBeNull();
  });

  it('returns an empty list for a missing directory (ENOENT-tolerant list)', async () => {
    expect(await transport.list(MISSING_DIR)).toEqual([]);
  });

  it('rejects a read that escapes the data root with `..`', async () => {
    await expect(transport.readJson(TRAVERSAL_PATH)).rejects.toThrow(ESCAPE_ERROR);
  });

  it('rejects a nested `..` sequence that resolves outside the root', async () => {
    await expect(transport.readJson(NESTED_TRAVERSAL_PATH)).rejects.toThrow(ESCAPE_ERROR);
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
    // `list('')` targets the root directory, which is inside the root and must not be rejected.
    expect(await transport.list('')).toEqual([]);
  });
});
