import { Injectable, InjectionToken, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { logWarn } from '../log';
import { Result, LoadError, ok } from '../result';
import { toLoadError } from '../http-load-error';
import { environment } from '../../../environments/environment';

// Paths are relative to the `data/specs/` root (e.g. `SubtletyRogue/burst/3176.json`).
export interface DataFileTransport {
  readJson<T>(relPath: string): Promise<Result<T, LoadError>>;
  // The write side is Node-ingestion only; the browser transport throws.
  writeJson(relPath: string, data: unknown): Promise<void>;
  remove(relPath: string): Promise<void>;
  list(relDir: string): Promise<string[]>;
}

export const DATA_FILE_TRANSPORT = new InjectionToken<DataFileTransport>('DATA_FILE_TRANSPORT');

const BROWSER_READONLY = 'DataFileApiService is read-only in the browser';

@Injectable({ providedIn: 'root' })
export class HttpDataFileTransport implements DataFileTransport {
  private readonly http = inject(HttpClient);
  // Deployed builds set an absolute `dataBaseHref` pointing at the single shared gh-pages-root data copy; empty (development) resolves relative to `document.baseURI`.
  private readonly base = new URL(environment.dataBaseHref || 'data/specs/', document.baseURI).href;

  async readJson<T>(relPath: string): Promise<Result<T, LoadError>> {
    try {
      return ok(await firstValueFrom(this.http.get<T>(`${this.base}${relPath}`)));
    } catch (cause) {
      logWarn(`DataFileTransport.readJson ${relPath}`, cause);
      return toLoadError(cause, `data-file.${relPath}`);
    }
  }

  writeJson(): Promise<void> { throw new Error(BROWSER_READONLY); }
  remove(): Promise<void> { throw new Error(BROWSER_READONLY); }
  list(): Promise<string[]> { throw new Error(BROWSER_READONLY); }
}
