import { InjectionToken } from '@angular/core';
import { Result } from '../result';

// Paths are relative to the `data/specs/` root (e.g. `SubtletyRogue/burst/3176.json`).
export interface DataFileTransport {
  readJson<T>(relPath: string): Promise<Result<T>>;
  // The write side is Node-ingestion only; the browser transport throws.
  writeJson(relPath: string, data: unknown): Promise<void>;
  remove(relPath: string): Promise<void>;
  list(relDir: string): Promise<string[]>;
}

export const DATA_FILE_TRANSPORT = new InjectionToken<DataFileTransport>('DATA_FILE_TRANSPORT');
