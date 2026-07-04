import { describe, it, expect, afterEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { DataFileTransport, HttpDataFileTransport } from './data-file-transport';

/**
 * The browser transport is a read-only HTTP GET of the static ingested files. These
 * tests pin the two behaviors the runtime relies on: a slice read resolves the file
 * under the configured data base, and a failed read (a spec/encounter with no ingested
 * file yet, so a 404) degrades to null instead of throwing - the "missing file is not
 * an error" contract every *DataSource depends on. The write side is a hard error in
 * the browser (only the Node ingestion writes).
 */
const REL_PATH = 'SubtletyRogue/burst/3176.json';
const SLICE_BODY = { encounter_id: 3176, sample_count: 5 };
const NOT_FOUND_STATUS = 404;
const BROWSER_READONLY_ERROR = /read-only in the browser/;

// The transport is exercised through its interface, so the read-only write-side methods
// are called with the arguments real callers pass (the browser impl ignores them and throws).
function setup(): { transport: DataFileTransport; httpMock: HttpTestingController } {
  TestBed.configureTestingModule({
    providers: [HttpDataFileTransport, provideHttpClient(), provideHttpClientTesting()],
  });
  return {
    transport: TestBed.inject(HttpDataFileTransport),
    httpMock: TestBed.inject(HttpTestingController),
  };
}

/** Silences and captures the transport's logWarn output on a failed read. */
function spyOnWarn() {
  return vi.spyOn(console, 'warn').mockImplementation(() => undefined);
}

describe('HttpDataFileTransport', () => {
  afterEach(() => {
    TestBed.inject(HttpTestingController).verify();
    vi.restoreAllMocks();
  });

  it('GETs the relative path under the data base and returns the parsed body', async () => {
    const { transport, httpMock } = setup();

    const pending = transport.readJson<typeof SLICE_BODY>(REL_PATH);
    const req = httpMock.expectOne(request => request.url.endsWith(`data/specs/${REL_PATH}`));
    expect(req.request.method).toBe('GET');
    req.flush(SLICE_BODY);

    expect(await pending).toEqual(SLICE_BODY);
  });

  it('resolves to null and logs a warning when the file is missing (404)', async () => {
    const warn = spyOnWarn();
    const { transport, httpMock } = setup();

    const pending = transport.readJson(REL_PATH);
    httpMock
      .expectOne(request => request.url.endsWith(`data/specs/${REL_PATH}`))
      .flush('Not found', { status: NOT_FOUND_STATUS, statusText: 'Not Found' });

    expect(await pending).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it('throws on every write-side method - the browser transport is read-only', () => {
    const { transport } = setup();

    expect(() => transport.writeJson(REL_PATH, SLICE_BODY)).toThrow(BROWSER_READONLY_ERROR);
    expect(() => transport.remove(REL_PATH)).toThrow(BROWSER_READONLY_ERROR);
    expect(() => transport.list('SubtletyRogue/burst')).toThrow(BROWSER_READONLY_ERROR);
  });
});
