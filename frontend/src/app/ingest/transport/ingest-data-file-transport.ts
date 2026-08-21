import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { DataFileTransport } from '../../core/services/data-file-transport';
import { Result, ok, permanent } from '../../core/result';
import { logWarn } from '../../core/log';
import { toLoadError } from '../../core/transport/http-load-error';
import { INGEST_VERSION } from '../ingest-version';
import { isFutureVersion } from '../signature';

/** The file server (scripts/ingest-server.js) is dumb file ops; all ingestion semantics stay on this side. */
export const INGEST_SERVER_URL = 'http://localhost:3000';

// The file server is rooted one level up at data/ so a single containment guard covers the whole data folder.
const SPECS_PREFIX = 'specs/';

function fileUrl(relPath: string): string {
  return `${INGEST_SERVER_URL}/api/data/${SPECS_PREFIX}${relPath}`;
}

/** The server returns an exact 404 for an absent file - the `missing` signal. */
@Injectable({ providedIn: 'root' })
export class IngestHttpDataFileTransport implements DataFileTransport {
  private readonly http = inject(HttpClient);

  async readJson<T>(relPath: string): Promise<Result<T>> {
    let parsed: unknown;
    try {
      parsed = await firstValueFrom(this.http.get<unknown>(fileUrl(relPath)));
    } catch (cause) {
      const result = toLoadError(cause, `data-file.${relPath}`);
      // An un-ingested file is the orchestrator's normal case, so only real failures log.
      if (!result.ok && result.error.kind !== 'missing') {
        logWarn(`IngestHttpDataFileTransport.readJson ${relPath}`, cause);
      }
      return result;
    }
    // A newer-versioned file has a shape this build does not know; fail it rather than cast the drifted JSON to T.
    if (isFutureVersion(parsed, INGEST_VERSION)) {
      return permanent('Data file is from a newer ingest version.', `data-file.version.${relPath}`);
    }
    return ok(parsed as T);
  }

  async writeJson(relPath: string, data: unknown): Promise<void> {
    await firstValueFrom(this.http.put(fileUrl(relPath), data));
  }

  async remove(relPath: string): Promise<void> {
    await firstValueFrom(this.http.delete(fileUrl(relPath)));
  }

  async list(relDir: string): Promise<string[]> {
    return await firstValueFrom(this.http.get<string[]>(`${INGEST_SERVER_URL}/api/dirs/${SPECS_PREFIX}${relDir}`));
  }
}
