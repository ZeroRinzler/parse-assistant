import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

const TOKEN_URL = 'https://www.warcraftlogs.com/oauth/token';

// WCL OAuth client used for the browser's client-credentials grant.
//
// INTENTIONAL SECRET EXPOSURE: this secret ships inside the static JS bundle and is
// therefore public. That is a deliberate design choice. The client-credentials token
// only grants access to the same public WCL report data the previous PKCE login flow
// already read - there is no private data behind it and no per-user budget to lose.
// The sole risk is that someone extracts the secret and drains our shared hourly
// rate-limit budget. Mitigation is manual: regenerate the secret at
// warcraftlogs.com/api/clients/ and redeploy (WCL exposes no API to rotate a secret,
// so this cannot be automated). See the project notes on this trade-off.
const CLIENT_ID = 'a21cf850-4cf8-4591-b3e5-906aba0da145';
const CLIENT_SECRET = 'ZYBFec16gC0CfwaunQjSAwUCQwEXTKOFo5JkwSze';

/**
 * The client-credentials pair. In the browser there is no `process`, so it always
 * uses the embedded (intentionally public) secret. The Node ingestion sets
 * `WCL_CLIENT_ID`/`WCL_CLIENT_SECRET` (server-side GHA secrets) which take precedence -
 * the same env vars the old ingest client used. Read via `globalThis` so the app
 * bundle needs no Node types and `process` never appears in browser code.
 */
function clientCredentials(): { id: string; secret: string } {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return {
    id: env?.['WCL_CLIENT_ID'] || CLIENT_ID,
    secret: env?.['WCL_CLIENT_SECRET'] || CLIENT_SECRET,
  };
}

interface TokenResponse {
  access_token: string;
  expires_in?: number;
}

@Injectable({ providedIn: 'root' })
export class WclAuthService {
  private readonly http = inject(HttpClient);
  private _token: string | null = null;
  private _expiry = 0;
  private _inFlight: Promise<string> | null = null;

  /**
   * Returns a valid WCL access token, fetching a fresh one via the client-credentials
   * grant when the cached token is missing or within 60s of expiry. Concurrent callers
   * share a single in-flight request. There is no user login: the token authenticates
   * the app itself, so it is acquired silently on first use and renewed transparently.
   */
  async getToken(): Promise<string> {
    if (this._token && Date.now() < this._expiry - 60_000) return this._token;
    if (this._inFlight) return this._inFlight;
    this._inFlight = this._fetchToken().finally(() => { this._inFlight = null; });
    return this._inFlight;
  }

  private async _fetchToken(): Promise<string> {
    const { id, secret } = clientCredentials();
    const params = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: id,
      client_secret: secret,
    });
    let data: TokenResponse;
    try {
      data = await firstValueFrom(this.http.post<TokenResponse>(
        TOKEN_URL,
        params.toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      ));
    } catch (err) {
      const status = err instanceof HttpErrorResponse ? err.status : 0;
      const detail = err instanceof HttpErrorResponse
        ? (typeof err.error === 'string' ? err.error : JSON.stringify(err.error))
        : '';
      throw new Error(`WCL token request failed (${status}): ${detail}`);
    }
    this._token = data.access_token;
    this._expiry = Date.now() + (data.expires_in || 3600) * 1000;
    return this._token;
  }

  /** Drop the cached token so the next request fetches a fresh one (e.g. after a 401). */
  invalidate(): void {
    this._token = null;
    this._expiry = 0;
  }
}
