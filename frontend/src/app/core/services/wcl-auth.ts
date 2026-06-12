import { Injectable, signal, computed } from '@angular/core';

const CLIENT_ID = 'a1ff2833-d873-4e41-9965-eea3f622586f';
const AUTH_URL = 'https://www.warcraftlogs.com/oauth/authorize';
const TOKEN_URL = 'https://www.warcraftlogs.com/oauth/token';

@Injectable({ providedIn: 'root' })
export class WclAuthService {
  private readonly _token = signal<string | null>(this._loadToken());
  readonly isLoggedIn = computed(() => this._token() !== null);

  private _loadToken(): string | null {
    const tok = localStorage.getItem('wcl_token');
    const exp = parseInt(localStorage.getItem('wcl_token_expiry') || '0', 10);
    return tok && Date.now() < exp - 60_000 ? tok : null;
  }

  getToken(): string | null {
    return this._token();
  }

  async login(): Promise<void> {
    const verifier = this._generateVerifier();
    const challenge = await this._generateChallenge(verifier);
    sessionStorage.setItem('wcl_code_verifier', verifier);
    sessionStorage.setItem('wcl_return_path', window.location.href);
    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: this._redirectUri(),
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    window.location.href = `${AUTH_URL}?${params}`;
  }

  async exchangeCode(code: string): Promise<void> {
    const verifier = sessionStorage.getItem('wcl_code_verifier');
    if (!verifier) throw new Error('No code verifier — auth flow was not started in this browser tab');
    const resp = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: CLIENT_ID,
        code,
        redirect_uri: this._redirectUri(),
        code_verifier: verifier,
      }),
    });
    if (!resp.ok) throw new Error(`WCL token exchange failed (${resp.status}): ${await resp.text()}`);
    const data = await resp.json();
    localStorage.setItem('wcl_token', data.access_token);
    localStorage.setItem('wcl_token_expiry', String(Date.now() + (data.expires_in || 3600) * 1000));
    sessionStorage.removeItem('wcl_code_verifier');
    this._token.set(data.access_token);
  }

  logout(): void {
    localStorage.removeItem('wcl_token');
    localStorage.removeItem('wcl_token_expiry');
    localStorage.removeItem('wcl_user_chars');
    this._token.set(null);
  }

  private _redirectUri(): string {
    return `${window.location.origin}/callback`;
  }

  private _generateVerifier(): string {
    const b = new Uint8Array(32);
    crypto.getRandomValues(b);
    return this._b64url(b.buffer);
  }

  private async _generateChallenge(verifier: string): Promise<string> {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    return this._b64url(buf);
  }

  private _b64url(buf: ArrayBuffer): string {
    return btoa(String.fromCharCode(...new Uint8Array(buf)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  }
}
