import { describe, it, expect } from 'vitest';
import {
  encounterSignature, readStoredSignature, signatureMatches, stampSignature,
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

  it('changes when only the code-hash changes (same parse set)', () => {
    const set = rankings(['r1', 1], ['r2', 2]);
    expect(encounterSignature('hashA', set)).not.toBe(encounterSignature('hashB', set));
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

describe('signatureMatches', () => {
  it('matches only an identical non-null stored signature', () => {
    expect(signatureMatches('sig', 'sig')).toBe(true);
    expect(signatureMatches('sig', 'other')).toBe(false);
    expect(signatureMatches(null, 'sig')).toBe(false);
  });
});

describe('stampSignature', () => {
  it('adds source_signature without mutating the original', () => {
    const original = { spec: 'X', encounter_id: 1 };
    const stamped = stampSignature(original, 'sig');
    expect(stamped).toEqual({ spec: 'X', encounter_id: 1, source_signature: 'sig' });
    expect(original).not.toHaveProperty('source_signature');
  });

  it('round-trips: a stamped file matches its own signature', () => {
    const sig = encounterSignature('code', rankings(['r1', 1]));
    const stamped = stampSignature({ data: true }, sig);
    expect(signatureMatches(readStoredSignature(stamped), sig)).toBe(true);
  });
});
