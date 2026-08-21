import { describe, it, expect, afterEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { IngestHttpDataFileTransport, INGEST_SERVER_URL } from './ingest-data-file-transport';
import { INGEST_VERSION } from '../ingest-version';
import { ok, missing } from '../../core/result';

const REL_PATH = 'SubtletyRogue/burst/3176.json';
// The file server is rooted at data/, one level above the specs tree the transport addresses.
const SERVER_FILE_PATH = `specs/${REL_PATH}`;
const SLICE_BODY = { encounter_id: 3176, sample_count: 5, ingest_version: INGEST_VERSION };
const FUTURE_BODY = { encounter_id: 3176, ingest_version: INGEST_VERSION + 1 };
const NOT_FOUND_STATUS = 404;
const NO_CONTENT_STATUS = 204;
const MISSING_MESSAGE = 'Not yet ingested.';

function setup(): { transport: IngestHttpDataFileTransport; httpMock: HttpTestingController } {
  TestBed.configureTestingModule({
    providers: [provideHttpClient(), provideHttpClientTesting()],
  });
  return {
    transport: TestBed.inject(IngestHttpDataFileTransport),
    httpMock: TestBed.inject(HttpTestingController),
  };
}

describe('IngestHttpDataFileTransport', () => {
  afterEach(() => {
    TestBed.inject(HttpTestingController).verify();
    vi.restoreAllMocks();
  });

  it('GETs the server-rooted file path and returns ok(body)', async () => {
    const { transport, httpMock } = setup();

    const pending = transport.readJson<typeof SLICE_BODY>(REL_PATH);
    const req = httpMock.expectOne(`${INGEST_SERVER_URL}/api/data/${SERVER_FILE_PATH}`);
    expect(req.request.method).toBe('GET');
    req.flush(SLICE_BODY);

    expect(await pending).toEqual(ok(SLICE_BODY));
  });

  it('resolves missing on an exact 404 - the un-ingested signal', async () => {
    const { transport, httpMock } = setup();

    const pending = transport.readJson(REL_PATH);
    httpMock
      .expectOne(`${INGEST_SERVER_URL}/api/data/${SERVER_FILE_PATH}`)
      .flush({ error: 'not found' }, { status: NOT_FOUND_STATUS, statusText: 'Not Found' });

    expect(await pending).toEqual(missing(MISSING_MESSAGE));
  });

  it('fails a file stamped with a future ingest version as permanent', async () => {
    const { transport, httpMock } = setup();

    const pending = transport.readJson(REL_PATH);
    httpMock.expectOne(`${INGEST_SERVER_URL}/api/data/${SERVER_FILE_PATH}`).flush(FUTURE_BODY);

    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('permanent');
  });

  it('PUTs writes to the file path with the document as the body', async () => {
    const { transport, httpMock } = setup();

    const pending = transport.writeJson(REL_PATH, SLICE_BODY);
    const req = httpMock.expectOne(`${INGEST_SERVER_URL}/api/data/${SERVER_FILE_PATH}`);
    expect(req.request.method).toBe('PUT');
    expect(req.request.body).toEqual(SLICE_BODY);
    req.flush(null, { status: NO_CONTENT_STATUS, statusText: 'No Content' });

    await pending;
  });

  it('DELETEs the file path on remove', async () => {
    const { transport, httpMock } = setup();

    const pending = transport.remove(REL_PATH);
    const req = httpMock.expectOne(`${INGEST_SERVER_URL}/api/data/${SERVER_FILE_PATH}`);
    expect(req.request.method).toBe('DELETE');
    req.flush(null, { status: NO_CONTENT_STATUS, statusText: 'No Content' });

    await pending;
  });

  it('GETs the directory resource and returns its entries', async () => {
    const { transport, httpMock } = setup();

    const pending = transport.list('SubtletyRogue/burst');
    const req = httpMock.expectOne(`${INGEST_SERVER_URL}/api/dirs/specs/SubtletyRogue/burst`);
    expect(req.request.method).toBe('GET');
    req.flush(['3176.json', '3177.json']);

    expect(await pending).toEqual(['3176.json', '3177.json']);
  });
});
