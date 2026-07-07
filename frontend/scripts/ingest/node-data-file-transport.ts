/**
 * Filesystem `DataFileTransport` over `frontend/public/data/specs/**`, so ingestion persists
 * through the same `DataFileApiService` the browser fills with HTTP reads.
 */
import fs from 'fs';
import path from 'path';
import type { DataFileTransport } from '../../src/app/core/services/data-file-transport.ts';
import { Result, LoadError, ok, missing, permanent } from '../../src/app/core/result.ts';
import { INGEST_VERSION } from './ingest-version.ts';
import { isFutureVersion } from './signature.ts';

// Monotonic suffix so two concurrent writes to the same path never collide on the temp name.
let tempWriteCounter = 0;

export class FsDataFileTransport implements DataFileTransport {
  constructor(private readonly root: string) {}

  private resolve(relPath: string): string {
    // Reject a crafted relPath whose `..` segments resolve outside the data root, so no
    // read/write/list can escape it.
    const root = path.resolve(this.root);
    const full = path.resolve(root, relPath);
    if (full !== root && !full.startsWith(root + path.sep)) {
      throw new Error(`Path escapes data root: ${relPath}`);
    }
    return full;
  }

  async readJson<T>(relPath: string): Promise<Result<T, LoadError>> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.promises.readFile(this.resolve(relPath), 'utf8'));
    } catch (cause) {
      // An absent file is the un-ingested `missing` case, mirroring the browser 404.
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return missing('Not yet ingested.');
      return permanent('Data file could not be read.', `data-file.${relPath}`, cause);
    }
    // A newer-versioned file has a shape this build does not know; fail it (driving a re-ingest)
    // rather than cast the drifted JSON to T.
    if (isFutureVersion(parsed, INGEST_VERSION)) {
      return permanent('Data file is from a newer ingest version.', `data-file.version.${relPath}`);
    }
    return ok(parsed as T);
  }

  async writeJson(relPath: string, data: unknown): Promise<void> {
    const full = this.resolve(relPath);
    await fs.promises.mkdir(path.dirname(full), { recursive: true });
    // Minified: the bench data is machine-read across thousands of files, so dropping
    // pretty-print indentation cuts the deployed footprint by roughly 70%.
    // Temp-then-rename so a kill mid-write leaves the previous complete file, not a truncated one.
    const tmp = `${full}.${process.pid}.${tempWriteCounter++}.tmp`;
    try {
      await fs.promises.writeFile(tmp, JSON.stringify(data) + '\n');
      await fs.promises.rename(tmp, full);
    } catch (err) {
      await fs.promises.rm(tmp, { force: true });
      throw err;
    }
  }

  async remove(relPath: string): Promise<void> {
    await fs.promises.rm(this.resolve(relPath), { force: true });
  }

  async list(relDir: string): Promise<string[]> {
    try {
      return (await fs.promises.readdir(this.resolve(relDir))).sort();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }
}
