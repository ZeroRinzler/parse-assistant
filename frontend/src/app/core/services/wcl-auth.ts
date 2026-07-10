import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { logWarn } from '../log';
import { WclTransportError } from './wcl-transport';
import { environment } from '../../../environments/environment';

const TOKEN_URL = 'https://www.warcraftlogs.com/oauth/token';

/**
 * sessionStorage key the cached token + its expiry are persisted under, so a page
 * reload reuses a still-valid token instead of spending a round trip on a fresh grant.
 * Per-tab (sessionStorage, not localStorage) and cleared on tab close, which matches an
 * app-level, ~1h client-credentials token.
 */
const TOKEN_STORAGE_KEY = 'wcl.token';

interface StoredToken { token: string; expiry: number; }

/**
 * `sessionStorage` if it is reachable, else null. Access can throw in locked-down
 * browsers, so every use is best-effort - persistence is an optimization, never a
 * correctness dependency.
 */
function sessionStore(): Storage | null {
  try {
    return (globalThis as { sessionStorage?: Storage }).sessionStorage ?? null;
  } catch {
    return null;
  }
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
   *
   * The in-memory cache is seeded once from sessionStorage, so a page reload reuses a
   * still-valid token from an earlier visit instead of always spending a fresh grant.
   */
  async getToken(): Promise<string> {
    if (!this._token) this._hydrateFromStorage();
    if (this._token && Date.now() < this._expiry - 60_000) return this._token;
    if (this._inFlight) return this._inFlight;
    this._inFlight = this._fetchToken().finally(() => { this._inFlight = null; });
    return this._inFlight;
  }

  /** Seed the in-memory token from sessionStorage (best-effort; a bad/absent entry is ignored). */
  private _hydrateFromStorage(): void {
    const store = sessionStore();
    if (!store) return;
    try {
      const raw = store.getItem(TOKEN_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as StoredToken;
      if (typeof parsed?.token === 'string' && typeof parsed?.expiry === 'number') {
        this._token = parsed.token;
        this._expiry = parsed.expiry;
      }
    } catch (err) {
      logWarn('WclAuthService._hydrateFromStorage', err);
    }
  }

  private async _fetchToken(): Promise<string> {
    const params = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: environment.wclClientId,
      client_secret: environment.wclClientSecret,
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
      // Keep the status so toLoadError can tell a transient outage from a rejected secret;
      // a bare Error would discard it and always classify as permanent.
      throw new WclTransportError(`WCL token request failed (${status}): ${detail}`, status);
    }
    const accessToken = data?.access_token;
    if (typeof accessToken !== 'string' || accessToken.length === 0) {
      // A 200 with no token (captive portal): reject as transient rather than cache junk
      // that 401-loops for an hour.
      throw new WclTransportError('WCL token response carried no access_token.', 0);
    }
    this._token = accessToken;
    this._expiry = Date.now() + (data.expires_in || 3600) * 1000;
    this._persist();
    return this._token;
  }

  /** Persist the freshly fetched token so a reload can reuse it (best-effort). */
  private _persist(): void {
    const store = sessionStore();
    if (!store || !this._token) return;
    try {
      store.setItem(TOKEN_STORAGE_KEY, JSON.stringify({ token: this._token, expiry: this._expiry }));
    } catch (err) {
      logWarn('WclAuthService._persist', err);
    }
  }

  /** Drop the cached token so the next request fetches a fresh one (e.g. after a 401). */
  invalidate(): void {
    this._token = null;
    this._expiry = 0;
    const store = sessionStore();
    if (!store) return;
    try {
      store.removeItem(TOKEN_STORAGE_KEY);
    } catch (err) {
      logWarn('WclAuthService.invalidate', err);
    }
  }
}
