import { describe, it, expect } from 'vitest';
import { HttpErrorResponse } from '@angular/common/http';
import { HttpLoadErrors } from './http-load-error';
import { Results } from './result';
import { WclTransportError } from '../wcl/wcl-transport';

const REPRO_ID = 'gear.load';

const HTTP_NOT_FOUND = 404;
const HTTP_SERVER_ERROR = 500;
const HTTP_SERVICE_UNAVAILABLE = 503;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_TIMEOUT = 408;
const HTTP_NETWORK_OR_CORS = 0;
const HTTP_FORBIDDEN = 403;
const HTTP_BAD_REQUEST = 400;

const TRANSIENT = Results.transient('WCL is unreachable right now.');
const PERMANENT_MESSAGE = 'Analysis data could not be loaded.';

function httpError(status: number): HttpErrorResponse {
  return new HttpErrorResponse({ status });
}

describe('toLoadError', () => {
  it('maps a 404 to missing (an un-ingested spec/boss, not a failure)', () => {
    expect(HttpLoadErrors.toLoadError(httpError(HTTP_NOT_FOUND), REPRO_ID)).toEqual(Results.missing('Not yet ingested.'));
  });

  it('maps a 500 to transient', () => {
    expect(HttpLoadErrors.toLoadError(httpError(HTTP_SERVER_ERROR), REPRO_ID)).toEqual(TRANSIENT);
  });

  it('maps a 503 to transient', () => {
    expect(HttpLoadErrors.toLoadError(httpError(HTTP_SERVICE_UNAVAILABLE), REPRO_ID)).toEqual(TRANSIENT);
  });

  it('maps a 429 rate-limit to transient', () => {
    expect(HttpLoadErrors.toLoadError(httpError(HTTP_TOO_MANY_REQUESTS), REPRO_ID)).toEqual(TRANSIENT);
  });

  it('maps a 408 timeout to transient', () => {
    expect(HttpLoadErrors.toLoadError(httpError(HTTP_TIMEOUT), REPRO_ID)).toEqual(TRANSIENT);
  });

  it('maps a status-0 network/CORS drop to transient', () => {
    expect(HttpLoadErrors.toLoadError(httpError(HTTP_NETWORK_OR_CORS), REPRO_ID)).toEqual(TRANSIENT);
  });

  it('maps a status-0 WclTransportError (GraphQL-level failure) to transient', () => {
    expect(HttpLoadErrors.toLoadError(new WclTransportError('graphql exploded', HTTP_NETWORK_OR_CORS), REPRO_ID)).toEqual(TRANSIENT);
  });

  it('maps a 403 to permanent, carrying the repro id and the original cause', () => {
    const cause = httpError(HTTP_FORBIDDEN);
    expect(HttpLoadErrors.toLoadError(cause, REPRO_ID)).toEqual(Results.permanent(PERMANENT_MESSAGE, REPRO_ID, cause));
  });

  it('maps a 400 to permanent', () => {
    const cause = httpError(HTTP_BAD_REQUEST);
    expect(HttpLoadErrors.toLoadError(cause, REPRO_ID)).toEqual(Results.permanent(PERMANENT_MESSAGE, REPRO_ID, cause));
  });

  it('maps an unknown non-HTTP throw to permanent', () => {
    const cause = new Error('unexpected');
    expect(HttpLoadErrors.toLoadError(cause, REPRO_ID)).toEqual(Results.permanent(PERMANENT_MESSAGE, REPRO_ID, cause));
  });
});
