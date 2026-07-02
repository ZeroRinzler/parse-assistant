/**
 * Node data-file transport: a filesystem implementation of the same
 * `DataFileTransport` the browser fills with HTTP reads. Reads + writes + lists
 * `frontend/public/data/specs/**`, so the ingestion persists the transforms' output
 * through the same `DataFileApiService` the runtime reads from.
 */
import fs from 'fs';
import path from 'path';
import type { DataFileTransport } from '../../src/app/core/services/data-file-transport.ts';

export class FsDataFileTransport implements DataFileTransport {
  constructor(private readonly root: string) {}

  private resolve(relPath: string): string {
    // Contain every access to the data root: a crafted relPath with `..` segments would
    // otherwise let a read/write/list escape `frontend/public/data/specs/**`. Normalize the
    // join and reject anything that resolves outside the root.
    const root = path.resolve(this.root);
    const full = path.resolve(root, relPath);
    if (full !== root && !full.startsWith(root + path.sep)) {
      throw new Error(`Path escapes data root: ${relPath}`);
    }
    return full;
  }

  async readJson<T>(relPath: string): Promise<T | null> {
    try {
      return JSON.parse(await fs.promises.readFile(this.resolve(relPath), 'utf8')) as T;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async writeJson(relPath: string, data: unknown): Promise<void> {
    const full = this.resolve(relPath);
    await fs.promises.mkdir(path.dirname(full), { recursive: true });
    await fs.promises.writeFile(full, JSON.stringify(data, null, 2) + '\n');
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
