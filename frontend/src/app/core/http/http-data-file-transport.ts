import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { DataFileTransport } from '../data-files/data-file-transport';
import { LoggerService } from '../observability/logger-service';
import { Result, Results } from './result';
import { HttpLoadErrors } from './http-load-error';
import { environment } from '../../../environments/environment';

const BROWSER_READONLY = 'DataFileApiService is read-only in the browser';

@Injectable({ providedIn: 'root' })
export class HttpDataFileTransport implements DataFileTransport {
  private readonly logger = inject(LoggerService);
  private readonly http = inject(HttpClient);
  // Deployed builds set an absolute `dataBaseHref` pointing at the single shared gh-pages-root data copy; empty (development) resolves relative to `document.baseURI`.
  private readonly base = new URL(environment.dataBaseHref || 'data/specs/', document.baseURI).href;

  async readJson<T>(relPath: string): Promise<Result<T>> {
    try {
      return Results.ok(await firstValueFrom(this.http.get<T>(`${this.base}${relPath}`)));
    } catch (cause) {
      this.logger.logWarn(`HttpDataFileTransport.readJson ${relPath}`, cause);
      return HttpLoadErrors.toLoadError(cause, `data-file.${relPath}`);
    }
  }

  writeJson(): Promise<void> { throw new Error(BROWSER_READONLY); }
  remove(): Promise<void> { throw new Error(BROWSER_READONLY); }
  list(): Promise<string[]> { throw new Error(BROWSER_READONLY); }
}
