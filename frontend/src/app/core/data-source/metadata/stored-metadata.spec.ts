import { describe, it, expect } from 'vitest';
import { readStoredMetadata, signatureMatches, isFutureVersion, type StampedFile } from './stored-metadata';

const VERSION = 6;
const INGESTED_AT_S = 1776245400;
const UNSTAMPED = { signature: null, version: null, ingestedAtS: null, inaccessibleParses: new Set() };

describe('readStoredMetadata', () => {
  it('reads every stamped field off a file', () => {
    const file: StampedFile = {
      source_signature: 'sig', ingest_version: VERSION, ingested_at_s: INGESTED_AT_S, inaccessible_parses: ['r1:1', 'r2:2'],
    };
    expect(readStoredMetadata(file)).toEqual({
      signature: 'sig', version: VERSION, ingestedAtS: INGESTED_AT_S, inaccessibleParses: new Set(['r1:1', 'r2:2']),
    });
  });

  it('defaults every field for an absent or unstamped file', () => {
    expect(readStoredMetadata(null)).toEqual(UNSTAMPED);
    expect(readStoredMetadata(undefined)).toEqual(UNSTAMPED);
    expect(readStoredMetadata({})).toEqual(UNSTAMPED);
    expect(readStoredMetadata({ ingest_version: VERSION })).toEqual({ ...UNSTAMPED, version: VERSION });
  });

  it('reads version 0 rather than defaulting it away', () => {
    expect(readStoredMetadata({ ingest_version: 0 }).version).toBe(0);
  });
});

describe('signatureMatches', () => {
  it('matches only an identical non-null stored signature', () => {
    expect(signatureMatches('sig', 'sig')).toBe(true);
    expect(signatureMatches('sig', 'other')).toBe(false);
    expect(signatureMatches(null, 'sig')).toBe(false);
  });
});

describe('isFutureVersion', () => {
  it('flags a file stamped with a newer ingest version', () => {
    expect(isFutureVersion({ ingest_version: VERSION + 1 }, VERSION)).toBe(true);
  });

  it('passes a matching or older version', () => {
    expect(isFutureVersion({ ingest_version: VERSION }, VERSION)).toBe(false);
    expect(isFutureVersion({ ingest_version: VERSION - 1 }, VERSION)).toBe(false);
  });

  it('passes a file with no version stamp (manifest / rulebook)', () => {
    expect(isFutureVersion({ spec: 'X' }, VERSION)).toBe(false);
    expect(isFutureVersion([{ spec: 'X' }], VERSION)).toBe(false);
  });

  it('passes a non-object or a non-numeric version stamp', () => {
    expect(isFutureVersion(null, VERSION)).toBe(false);
    expect(isFutureVersion('nope', VERSION)).toBe(false);
    expect(isFutureVersion({ ingest_version: 'seven' }, VERSION)).toBe(false);
    expect(isFutureVersion({ ingest_version: Number.NaN }, VERSION)).toBe(false);
  });
});
