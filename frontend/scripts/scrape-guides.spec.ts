import { describe, it, expect } from 'vitest';
import { assertHttps } from './scrape-guides.ts';

const HTTPS_URL = 'https://example.com/guide';
const HTTP_URL = 'http://example.com/guide';
const FTP_URL = 'ftp://example.com/guide';
const NOT_A_URL = 'not a url';
const NON_HTTPS_ERROR = /non-https/;
const INVALID_URL_ERROR = /Invalid guide URL/;

describe('assertHttps', () => {
  it('accepts an https URL', () => {
    expect(() => assertHttps(HTTPS_URL)).not.toThrow();
  });

  it('rejects a plain http URL rather than downgrading the fetch', () => {
    expect(() => assertHttps(HTTP_URL)).toThrow(NON_HTTPS_ERROR);
  });

  it('rejects a non-http(s) scheme such as ftp', () => {
    expect(() => assertHttps(FTP_URL)).toThrow(NON_HTTPS_ERROR);
  });

  it('rejects an unparseable URL', () => {
    expect(() => assertHttps(NOT_A_URL)).toThrow(INVALID_URL_ERROR);
  });
});
