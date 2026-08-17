import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import * as z from '../zod-mini';
import { WclTransportError } from './wcl-transport';
import { environment } from '../../../environments/environment';

const TOKEN_URL = 'https://www.warcraftlogs.com/oauth/token';

const DEFAULT_TOKEN_LIFETIME_S = 3600;

const TOKEN_RESPONSE_SCHEMA = z.looseObject({
  access_token: z.string().check(z.minLength(1)),
  // An unusable lifetime falls back to the default rather than voiding an otherwise good token.
  expires_in: z.catch(z.optional(z.number().check(z.positive())), undefined),
});

@Injectable({ providedIn: 'root' })
export class WclAuthService {
  private readonly http = inject(HttpClient);
  private _token: string | null = null;
  private _expiry = 0;
  private _inFlight: Promise<string> | null = null;

  // There is no user login: the token authenticates the app itself, so it is acquired silently on first use and renewed transparently.
  async getToken(): Promise<string> {
    if (this._token && Date.now() < this._expiry - 60_000) return this._token;
    if (this._inFlight) return this._inFlight;
    this._inFlight = this._fetchToken().finally(() => { this._inFlight = null; });
    return this._inFlight;
  }

  private async _fetchToken(): Promise<string> {
    const params = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: environment.wclClientId,
      client_secret: environment.wclClientSecret,
    });
    let data: unknown;
    try {
      data = await firstValueFrom(this.http.post<unknown>(
        TOKEN_URL,
        params.toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      ));
    } catch (err) {
      const status = err instanceof HttpErrorResponse ? err.status : 0;
      const detail = err instanceof HttpErrorResponse
        ? (typeof err.error === 'string' ? err.error : JSON.stringify(err.error))
        : '';
      // Keep the status so toLoadError can tell a transient outage from a rejected secret; a bare Error would discard it and always classify as permanent.
      throw new WclTransportError(`WCL token request failed (${status}): ${detail}`, status);
    }
    const grant = TOKEN_RESPONSE_SCHEMA.safeParse(data);
    if (!grant.success) {
      // A 200 with no token (captive portal): reject as transient rather than cache junk that 401-loops for an hour.
      throw new WclTransportError('WCL token response carried no access_token.', 0);
    }
    this._token = grant.data.access_token;
    this._expiry = Date.now() + (grant.data.expires_in ?? DEFAULT_TOKEN_LIFETIME_S) * 1000;
    return this._token;
  }

  invalidate(): void {
    this._token = null;
    this._expiry = 0;
  }
}
