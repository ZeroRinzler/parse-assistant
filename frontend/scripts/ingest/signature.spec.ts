import { describe, it, expect } from 'vitest';
import {
  encounterSignature, readStoredSignature, readStoredVersion, signatureMatches, stampSignature,
  type SignatureRanking,
} from './signature.ts';

const rankings = (...rows: Array<[string, number]>): SignatureRanking[] =>
  rows.map(([report_code, fight_id]) => ({ report_code, fight_id }));

describe('encounterSignature', () => {
  it('produces a 16-char lowercase hex hash', () => {
    expect(encounterSignature('abc123', rankings(['r1', 1]))).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is independent of ranking order (sorted parse-set fingerprint)', () => {
    const a = encounterSignature('code', rankings(['r1', 1], ['r2', 2], ['r3', 3]));
    const b = encounterSignature('code', rankings(['r3', 3], ['r1', 1], ['r2', 2]));
    expect(a).toBe(b);
  });

  it('changes when the parse set changes', () => {
    const a = encounterSignature('code', rankings(['r1', 1], ['r2', 2]));
    const b = encounterSignature('code', rankings(['r1', 1], ['r2', 9]));
    expect(a).not.toBe(b);
  });

  it('changes when only the version changes (same parse set)', () => {
    const set = rankings(['r1', 1], ['r2', 2]);
    expect(encounterSignature('1', set)).not.toBe(encounterSignature('2', set));
  });

  it('distinguishes same report with different fight ids', () => {
    const a = encounterSignature('code', rankings(['r1', 1]));
    const b = encounterSignature('code', rankings(['r1', 2]));
    expect(a).not.toBe(b);
  });
});

describe('readStoredSignature', () => {
  it('reads source_signature from a file object', () => {
    expect(readStoredSignature({ source_signature: 'sig' })).toBe('sig');
  });

  it('returns null for missing / null / undefined', () => {
    expect(readStoredSignature(null)).toBeNull();
    expect(readStoredSignature(undefined)).toBeNull();
    expect(readStoredSignature({})).toBeNull();
  });
});

describe('readStoredVersion', () => {
  it('reads ingest_version off a stamped file', () => {
    expect(readStoredVersion({ ingest_version: 1 })).toBe(1);
    expect(readStoredVersion({ ingest_version: 0 })).toBe(0);
  });
});

describe('signatureMatches', () => {
  it('matches only an identical non-null stored signature', () => {
    expect(signatureMatches('sig', 'sig')).toBe(true);
    expect(signatureMatches('sig', 'other')).toBe(false);
    expect(signatureMatches(null, 'sig')).toBe(false);
  });
});

describe('stampSignature', () => {
  it('adds source_signature + ingest_version without mutating the original', () => {
    const original = { spec: 'X', encounter_id: 1 };
    const stamped = stampSignature(original, 'sig', 1);
    expect(stamped).toEqual({ spec: 'X', encounter_id: 1, source_signature: 'sig', ingest_version: 1 });
    expect(original).not.toHaveProperty('source_signature');
    expect(original).not.toHaveProperty('ingest_version');
  });

  it('round-trips: a stamped file matches its own signature and version', () => {
    const sig = encounterSignature('1', rankings(['r1', 1]));
    const stamped = stampSignature({ data: true }, sig, 1);
    expect(signatureMatches(readStoredSignature(stamped), sig)).toBe(true);
    expect(readStoredVersion(stamped)).toBe(1);
  });
});
