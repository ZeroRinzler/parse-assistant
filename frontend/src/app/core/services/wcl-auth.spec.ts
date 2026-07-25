import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { WclAuthService } from './wcl-auth';

/** The client-credentials token endpoint the service posts to (mirrors TOKEN_URL in the source). */
const WCL_TOKEN_URL = 'https://www.warcraftlogs.com/oauth/token';

/** Distinct tokens so a "reused vs refetched" assertion reads as documentation. */
const FIRST_TOKEN = 'wcl-access-token-first';
const SECOND_TOKEN = 'wcl-access-token-second';

/** WCL's default token lifetime when the response omits `expires_in`; also what we send here. */
const TOKEN_LIFETIME_S = 3600;

/** The service treats a token as stale this long before its real expiry (the refresh lead). */
const REFRESH_LEAD_MS = 60_000;

/** A cached token is reused only while the elapsed time since issue is strictly under this window. */
const REUSE_WINDOW_MS = TOKEN_LIFETIME_S * 1000 - REFRESH_LEAD_MS;

/** One millisecond inside the reuse window: the cached token must still be served. */
const JUST_INSIDE_REUSE_MS = REUSE_WINDOW_MS - 1;

/** A fixed, arbitrary base clock so `Date.now()` at issue time is deterministic under fake timers. */
const START_TIME_MS = 1_000_000_000;

function setup(): { service: WclAuthService; httpMock: HttpTestingController } {
  TestBed.configureTestingModule({
    providers: [WclAuthService, provideHttpClient(), provideHttpClientTesting()],
  });
  return {
    service: TestBed.inject(WclAuthService),
    httpMock: TestBed.inject(HttpTestingController),
  };
}

/** Answers the single pending token request with `token`, mimicking a successful WCL grant. */
function flushToken(httpMock: HttpTestingController, token: string): void {
  httpMock.expectOne(WCL_TOKEN_URL).flush({ access_token: token, expires_in: TOKEN_LIFETIME_S });
}

describe('WclAuthService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START_TIME_MS);
  });

  afterEach(() => {
    TestBed.inject(HttpTestingController).verify();
    vi.useRealTimers();
  });

  it('fetches a token via the client-credentials grant and returns it', async () => {
    const { service, httpMock } = setup();

    const pending = service.getToken();
    const req = httpMock.expectOne(WCL_TOKEN_URL);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toContain('grant_type=client_credentials');
    req.flush({ access_token: FIRST_TOKEN, expires_in: TOKEN_LIFETIME_S });

    expect(await pending).toBe(FIRST_TOKEN);
  });

  it('reuses the cached token for a call just inside the reuse window', async () => {
    const { service, httpMock } = setup();
    const first = service.getToken();
    flushToken(httpMock, FIRST_TOKEN);
    await first;

    vi.setSystemTime(START_TIME_MS + JUST_INSIDE_REUSE_MS);
    const second = await service.getToken();

    expect(second).toBe(FIRST_TOKEN);
    httpMock.expectNone(WCL_TOKEN_URL);
  });

  it('refetches once the token reaches the refresh window at the boundary', async () => {
    const { service, httpMock } = setup();
    const first = service.getToken();
    flushToken(httpMock, FIRST_TOKEN);
    await first;

    // At exactly REUSE_WINDOW_MS the strict `now < expiry - lead` guard flips, forcing a refetch.
    vi.setSystemTime(START_TIME_MS + REUSE_WINDOW_MS);
    const second = service.getToken();
    flushToken(httpMock, SECOND_TOKEN);

    expect(await second).toBe(SECOND_TOKEN);
  });

  it('shares a single in-flight request across concurrent callers', async () => {
    const { service, httpMock } = setup();

    const first = service.getToken();
    const second = service.getToken();

    const requests = httpMock.match(WCL_TOKEN_URL);
    expect(requests.length).toBe(1);
    requests[0].flush({ access_token: FIRST_TOKEN, expires_in: TOKEN_LIFETIME_S });

    expect(await first).toBe(FIRST_TOKEN);
    expect(await second).toBe(FIRST_TOKEN);
  });

  it('forces a fresh fetch after invalidate()', async () => {
    const { service, httpMock } = setup();
    const first = service.getToken();
    flushToken(httpMock, FIRST_TOKEN);
    await first;

    service.invalidate();
    const second = service.getToken();
    flushToken(httpMock, SECOND_TOKEN);

    expect(await second).toBe(SECOND_TOKEN);
  });

});
