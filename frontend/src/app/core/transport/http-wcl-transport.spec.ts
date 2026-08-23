import { describe, it, expect, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient, withInterceptorsFromDi } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { NgHttpCachingHeaders } from 'ng-http-caching';
import { HttpWclTransport } from './http-wcl-transport';
import { provideWclCaching } from '../services/wcl-caching';
import { RATE_LIMIT_Q } from '../services/wcl-queries';
import { WCL_API_URL, WCL_UNUSABLE_STATUS, WclTransportError } from '../services/wcl-transport';

// A generic (default-cached) query, distinct from the volatile/uncached app queries.
const QUERY = 'query Report($code: String!) { reportData { report(code: $code) { title } } }';
// RATE_LIMIT_Q is marked uncached by wclCachingHeaders, so it stands in for the always-fresh reads.
const UNCACHED_QUERY = RATE_LIMIT_Q;
const REPORT_CODE = 'AbCdEfGh12345678';
const OTHER_REPORT_CODE = 'ZyXwVuTs87654321';
const RUN_FAILURE = 'slice transform blew up';
const TOKEN = 'token-1';
const REPORT_DATA = { reportData: { report: { title: 'Weekly clear' } } };
const UNAUTHORIZED_STATUS = 401;
const SERVICE_UNAVAILABLE_STATUS = 503;
const PERMISSION_MESSAGE = 'You do not have permission to view this report.';
const OTHER_GRAPHQL_MESSAGE = 'Unknown fight id.';

function setup(): { transport: HttpWclTransport; httpMock: HttpTestingController } {
  TestBed.configureTestingModule({
    // The real caching interceptor is part of the contract under test, so it joins the chain exactly as in app.config.ts.
    providers: [provideWclCaching(), provideHttpClient(withInterceptorsFromDi()), provideHttpClientTesting()],
  });
  return {
    transport: TestBed.inject(HttpWclTransport),
    httpMock: TestBed.inject(HttpTestingController),
  };
}

async function failedFetch(
  transport: HttpWclTransport, httpMock: HttpTestingController,
  code: string, body: object | string, status?: number,
): Promise<void> {
  const pending = transport.query(QUERY, { code }, TOKEN);
  const request = httpMock.expectOne(WCL_API_URL);
  if (status == null) request.flush(body);
  else request.flush(body, { status, statusText: 'Failed' });
  await expect(pending).rejects.toBeInstanceOf(WclTransportError);
}

describe('HttpWclTransport', () => {
  afterEach(() => {
    TestBed.inject(HttpTestingController).verify();
  });

  it('POSTs the query and variables with the bearer token and unwraps data', async () => {
    const { transport, httpMock } = setup();

    const pending = transport.query(QUERY, { code: REPORT_CODE }, TOKEN);
    const req = httpMock.expectOne(WCL_API_URL);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ query: QUERY, variables: { code: REPORT_CODE } });
    expect(req.request.headers.get('Authorization')).toBe(`Bearer ${TOKEN}`);
    req.flush({ data: REPORT_DATA });

    expect(await pending).toEqual(REPORT_DATA);
  });

  it('serves a repeated default-cached query from the cache - one network request total', async () => {
    const { transport, httpMock } = setup();

    const first = transport.query(QUERY, { code: REPORT_CODE }, TOKEN);
    httpMock.expectOne(WCL_API_URL).flush({ data: REPORT_DATA });
    expect(await first).toEqual(REPORT_DATA);

    // Same query + variables again: no request may reach the backend (verify() enforces it).
    expect(await transport.query(QUERY, { code: REPORT_CODE }, TOKEN)).toEqual(REPORT_DATA);
  });

  it('dedupes two parallel default-cached queries into one in-flight request', async () => {
    const { transport, httpMock } = setup();

    const first = transport.query(QUERY, { code: REPORT_CODE }, TOKEN);
    const second = transport.query(QUERY, { code: REPORT_CODE }, TOKEN);
    httpMock.expectOne(WCL_API_URL).flush({ data: REPORT_DATA });

    expect(await first).toEqual(REPORT_DATA);
    expect(await second).toEqual(REPORT_DATA);
  });

  it('bypasses the cache for an uncached query and never leaks the caching header to WCL', async () => {
    const { transport, httpMock } = setup();

    const first = transport.query(UNCACHED_QUERY, {}, TOKEN);
    const firstReq = httpMock.expectOne(WCL_API_URL);
    // The interceptor consumes and strips its own control header before forwarding.
    expect(firstReq.request.headers.has(NgHttpCachingHeaders.DISALLOW_CACHE)).toBe(false);
    firstReq.flush({ data: REPORT_DATA });
    await first;

    // The identical query must reach the network again - nothing was cached.
    const second = transport.query(UNCACHED_QUERY, {}, TOKEN);
    httpMock.expectOne(WCL_API_URL).flush({ data: REPORT_DATA });
    expect(await second).toEqual(REPORT_DATA);
  });

  it('maps an HTTP error to WclTransportError carrying the real status', async () => {
    const { transport, httpMock } = setup();

    const pending = transport.query(UNCACHED_QUERY, {}, TOKEN);
    httpMock.expectOne(WCL_API_URL).flush('Unauthorized', { status: UNAUTHORIZED_STATUS, statusText: 'Unauthorized' });

    await expect(pending).rejects.toMatchObject({ name: 'WclTransportError', status: UNAUTHORIZED_STATUS });
  });

  it('throws WCL_UNUSABLE_STATUS on a 200 with a GraphQL errors array', async () => {
    const { transport, httpMock } = setup();

    const pending = transport.query(UNCACHED_QUERY, {}, TOKEN);
    httpMock.expectOne(WCL_API_URL).flush({ errors: [{ message: OTHER_GRAPHQL_MESSAGE }] });

    await expect(pending).rejects.toEqual(new WclTransportError(OTHER_GRAPHQL_MESSAGE, WCL_UNUSABLE_STATUS));
  });

  it('throws WCL_UNUSABLE_STATUS on a 200 with no data', async () => {
    const { transport, httpMock } = setup();

    const pending = transport.query(UNCACHED_QUERY, {}, TOKEN);
    httpMock.expectOne(WCL_API_URL).flush({});

    await expect(pending).rejects.toMatchObject({ name: 'WclTransportError', status: WCL_UNUSABLE_STATUS });
  });

  it('reports a permission-denied GraphQL error as both inaccessible and failed', async () => {
    const { transport, httpMock } = setup();

    const { outcomes } = await transport.withFetchOutcomes(() =>
      failedFetch(transport, httpMock, REPORT_CODE, { errors: [{ message: PERMISSION_MESSAGE }] }));

    expect(outcomes.failedCodes).toEqual(new Set([REPORT_CODE]));
    expect(outcomes.inaccessibleCodes).toEqual(new Set([REPORT_CODE]));
  });

  it('reports a transient HTTP failure as failed but not inaccessible', async () => {
    const { transport, httpMock } = setup();

    const { outcomes } = await transport.withFetchOutcomes(() =>
      failedFetch(transport, httpMock, REPORT_CODE, 'Unavailable', SERVICE_UNAVAILABLE_STATUS));

    expect(outcomes.failedCodes).toEqual(new Set([REPORT_CODE]));
    expect(outcomes.inaccessibleCodes).toEqual(new Set());
  });

  it('reports a non-permission GraphQL error as failed but not inaccessible', async () => {
    const { transport, httpMock } = setup();

    const { outcomes } = await transport.withFetchOutcomes(() =>
      failedFetch(transport, httpMock, REPORT_CODE, { errors: [{ message: OTHER_GRAPHQL_MESSAGE }] }));

    expect(outcomes.failedCodes).toEqual(new Set([REPORT_CODE]));
    expect(outcomes.inaccessibleCodes).toEqual(new Set());
  });

  it('reports no code for a 401 (the auth layer retries it)', async () => {
    const { transport, httpMock } = setup();

    const { outcomes } = await transport.withFetchOutcomes(() =>
      failedFetch(transport, httpMock, REPORT_CODE, 'Unauthorized', UNAUTHORIZED_STATUS));

    expect(outcomes.failedCodes).toEqual(new Set());
  });

  it('returns the value of run alongside the outcomes', async () => {
    const { transport, httpMock } = setup();

    const { result, outcomes } = await transport.withFetchOutcomes(() => {
      const pending = transport.query(QUERY, { code: REPORT_CODE }, TOKEN);
      httpMock.expectOne(WCL_API_URL).flush({ data: REPORT_DATA });
      return pending;
    });

    expect(result).toEqual(REPORT_DATA);
    expect(outcomes.failedCodes).toEqual(new Set());
  });

  it('starts a second scope empty', async () => {
    const { transport, httpMock } = setup();

    await transport.withFetchOutcomes(() =>
      failedFetch(transport, httpMock, REPORT_CODE, { errors: [{ message: PERMISSION_MESSAGE }] }));
    const { outcomes } = await transport.withFetchOutcomes(() =>
      failedFetch(transport, httpMock, OTHER_REPORT_CODE, { errors: [{ message: OTHER_GRAPHQL_MESSAGE }] }));

    expect(outcomes.failedCodes).toEqual(new Set([OTHER_REPORT_CODE]));
    expect(outcomes.inaccessibleCodes).toEqual(new Set());
  });

  it('closes a scope whose run throws, so its codes never reach the next scope', async () => {
    const { transport, httpMock } = setup();

    const thrown = transport.withFetchOutcomes(async () => {
      await failedFetch(transport, httpMock, REPORT_CODE, { errors: [{ message: PERMISSION_MESSAGE }] });
      throw new Error(RUN_FAILURE);
    });
    await expect(thrown).rejects.toThrow(RUN_FAILURE);

    const { outcomes } = await transport.withFetchOutcomes(() =>
      failedFetch(transport, httpMock, OTHER_REPORT_CODE, { errors: [{ message: OTHER_GRAPHQL_MESSAGE }] }));
    expect(outcomes.failedCodes).toEqual(new Set([OTHER_REPORT_CODE]));
    expect(outcomes.inaccessibleCodes).toEqual(new Set());
  });

  it('keeps a nested scope out of the enclosing one, and restores the enclosing one after it', async () => {
    const { transport, httpMock } = setup();
    let nestedFailed: ReadonlySet<string> = new Set();

    const { outcomes } = await transport.withFetchOutcomes(async () => {
      const inner = await transport.withFetchOutcomes(() =>
        failedFetch(transport, httpMock, REPORT_CODE, { errors: [{ message: OTHER_GRAPHQL_MESSAGE }] }));
      nestedFailed = inner.outcomes.failedCodes;
      await failedFetch(transport, httpMock, OTHER_REPORT_CODE, { errors: [{ message: OTHER_GRAPHQL_MESSAGE }] });
    });

    expect(nestedFailed).toEqual(new Set([REPORT_CODE]));
    expect(outcomes.failedCodes).toEqual(new Set([OTHER_REPORT_CODE]));
  });
});
