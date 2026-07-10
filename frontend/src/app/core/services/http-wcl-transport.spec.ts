import { describe, it, expect, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient, withInterceptorsFromDi } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { NgHttpCachingHeaders } from 'ng-http-caching';
import { HttpWclTransport } from './http-wcl-transport';
import { provideWclCaching } from './wcl-caching';
import { WCL_API_URL, WCL_UNUSABLE_STATUS, WclTransportError } from './wcl-transport';

const QUERY = 'query Report($code: String!) { reportData { report(code: $code) { title } } }';
const REPORT_CODE = 'AbCdEfGh12345678';
const TOKEN = 'token-1';
const REPORT_DATA = { reportData: { report: { title: 'Weekly clear' } } };
const UNAUTHORIZED_STATUS = 401;
const PERMISSION_MESSAGE = 'You do not have permission to view this report.';
const OTHER_GRAPHQL_MESSAGE = 'Unknown fight id.';
const CACHE_FIRST = true;
const NETWORK_ONLY = false;

function setup(): { transport: HttpWclTransport; httpMock: HttpTestingController } {
  TestBed.configureTestingModule({
    // The real caching interceptor is part of the contract under test, so it joins the
    // chain exactly as in app.config.ts.
    providers: [provideWclCaching(), provideHttpClient(withInterceptorsFromDi()), provideHttpClientTesting()],
  });
  return {
    transport: TestBed.inject(HttpWclTransport),
    httpMock: TestBed.inject(HttpTestingController),
  };
}

describe('HttpWclTransport', () => {
  afterEach(() => {
    TestBed.inject(HttpTestingController).verify();
  });

  it('POSTs the query and variables with the bearer token and unwraps data', async () => {
    const { transport, httpMock } = setup();

    const pending = transport.query(QUERY, { code: REPORT_CODE }, TOKEN, CACHE_FIRST);
    const req = httpMock.expectOne(WCL_API_URL);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ query: QUERY, variables: { code: REPORT_CODE } });
    expect(req.request.headers.get('Authorization')).toBe(`Bearer ${TOKEN}`);
    req.flush({ data: REPORT_DATA });

    expect(await pending).toEqual(REPORT_DATA);
  });

  it('serves a repeated cache-first query from the cache - one network request total', async () => {
    const { transport, httpMock } = setup();

    const first = transport.query(QUERY, { code: REPORT_CODE }, TOKEN, CACHE_FIRST);
    httpMock.expectOne(WCL_API_URL).flush({ data: REPORT_DATA });
    expect(await first).toEqual(REPORT_DATA);

    // Same query + variables again: no request may reach the backend (verify() enforces it).
    expect(await transport.query(QUERY, { code: REPORT_CODE }, TOKEN, CACHE_FIRST)).toEqual(REPORT_DATA);
  });

  it('dedupes two parallel cache-first queries into one in-flight request', async () => {
    const { transport, httpMock } = setup();

    const first = transport.query(QUERY, { code: REPORT_CODE }, TOKEN, CACHE_FIRST);
    const second = transport.query(QUERY, { code: REPORT_CODE }, TOKEN, CACHE_FIRST);
    httpMock.expectOne(WCL_API_URL).flush({ data: REPORT_DATA });

    expect(await first).toEqual(REPORT_DATA);
    expect(await second).toEqual(REPORT_DATA);
  });

  it('network-only queries bypass the cache and never leak the caching header to WCL', async () => {
    const { transport, httpMock } = setup();

    const first = transport.query(QUERY, { code: REPORT_CODE }, TOKEN, NETWORK_ONLY);
    const firstReq = httpMock.expectOne(WCL_API_URL);
    // The interceptor consumes and strips its own control header before forwarding.
    expect(firstReq.request.headers.has(NgHttpCachingHeaders.DISALLOW_CACHE)).toBe(false);
    firstReq.flush({ data: REPORT_DATA });
    await first;

    // The identical query must reach the network again - nothing was cached.
    const second = transport.query(QUERY, { code: REPORT_CODE }, TOKEN, NETWORK_ONLY);
    httpMock.expectOne(WCL_API_URL).flush({ data: REPORT_DATA });
    expect(await second).toEqual(REPORT_DATA);
  });

  it('maps an HTTP error to WclTransportError carrying the real status', async () => {
    const { transport, httpMock } = setup();

    const pending = transport.query(QUERY, { code: REPORT_CODE }, TOKEN, NETWORK_ONLY);
    httpMock.expectOne(WCL_API_URL).flush('Unauthorized', { status: UNAUTHORIZED_STATUS, statusText: 'Unauthorized' });

    await expect(pending).rejects.toMatchObject({ name: 'WclTransportError', status: UNAUTHORIZED_STATUS });
  });

  it('throws WCL_UNUSABLE_STATUS on a 200 with a GraphQL errors array', async () => {
    const { transport, httpMock } = setup();

    const pending = transport.query(QUERY, { code: REPORT_CODE }, TOKEN, NETWORK_ONLY);
    httpMock.expectOne(WCL_API_URL).flush({ errors: [{ message: OTHER_GRAPHQL_MESSAGE }] });

    await expect(pending).rejects.toEqual(new WclTransportError(OTHER_GRAPHQL_MESSAGE, WCL_UNUSABLE_STATUS));
    // A non-permission GraphQL error must not mark the report inaccessible.
    expect(transport.takeInaccessibleCodes()).toEqual([]);
  });

  it('throws WCL_UNUSABLE_STATUS on a 200 with no data', async () => {
    const { transport, httpMock } = setup();

    const pending = transport.query(QUERY, { code: REPORT_CODE }, TOKEN, NETWORK_ONLY);
    httpMock.expectOne(WCL_API_URL).flush({});

    await expect(pending).rejects.toMatchObject({ name: 'WclTransportError', status: WCL_UNUSABLE_STATUS });
  });

  it('records the report code on a permission-denied GraphQL error; take drains the set', async () => {
    const { transport, httpMock } = setup();

    const pending = transport.query(QUERY, { code: REPORT_CODE }, TOKEN, NETWORK_ONLY);
    httpMock.expectOne(WCL_API_URL).flush({ errors: [{ message: PERMISSION_MESSAGE }] });
    await expect(pending).rejects.toMatchObject({ status: WCL_UNUSABLE_STATUS });

    expect(transport.takeInaccessibleCodes()).toEqual([REPORT_CODE]);
    expect(transport.takeInaccessibleCodes()).toEqual([]);
  });
});
