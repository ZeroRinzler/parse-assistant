import { describe, it, expect } from 'vitest';
import {
  encounterSignature, encounterSkipKey, signatureAfterFetch, readStoredSignature, readStoredVersion,
  signatureMatches, stampSignature, stampBurstFile, parseKey, readInaccessibleParses,
  isFutureVersion,
  type SignatureRanking,
} from './signature';
import { ok, missing, transient, permanent, type Result, type LoadError } from '../core/result';

const rankings = (...rows: [string, number][]): SignatureRanking[] =>
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

describe('parseKey', () => {
  it('joins report code and fight id', () => {
    expect(parseKey({ report_code: 'r1', fight_id: 3 })).toBe('r1:3');
  });
});

describe('readInaccessibleParses', () => {
  it('reads the persisted key set', () => {
    expect(readInaccessibleParses({ inaccessible_parses: ['r1:1', 'r2:2'] })).toEqual(new Set(['r1:1', 'r2:2']));
  });

  it('returns an empty set for missing / null', () => {
    expect(readInaccessibleParses(null)).toEqual(new Set());
    expect(readInaccessibleParses({})).toEqual(new Set());
  });
});

describe('inaccessible-aware skip key', () => {
  // Each parse has a STABLE identity (report_code:fight_id) independent of its rank, so a
  // parse keeps its key when it moves position. The cases below drive the PRODUCTION
  // encounterSkipKey / signatureAfterFetch through thin fixture shims (array -> Set, fixed
  // version) - the two halves of the orchestrator: the cheap skip check and the post-fetch stamp.
  const P = (report_code: string): SignatureRanking => ({ report_code, fight_id: 1 });
  const pool = (...codes: string[]): SignatureRanking[] => codes.map(P);
  const sig = (rows: SignatureRanking[]): string => encounterSignature('1', rows);

  // Skip check (orchestrator loop): key on the top-N accessible parses (pool minus the
  // persisted known-inaccessible keys).
  const skipKey = (rows: SignatureRanking[], knownInaccessible: string[], n = 10): string =>
    encounterSkipKey(rows, new Set(knownInaccessible), '1', n);

  // Post-fetch stamp (ingestEncounter): given the report codes the fetch found inaccessible,
  // return the stamped signature + the inaccessible key set persisted on the burst file.
  // Codes never fetched (e.g. a parse below the 10th accessible) are naturally pruned.
  const stampAfterCompute = (rows: SignatureRanking[], inaccessibleCodes: string[], n = 10) => {
    const { signature, inaccessibleParses } = signatureAfterFetch(rows, new Set(inaccessibleCodes), '1', n);
    return { signature, inaccessible_parses: inaccessibleParses };
  };

  it('is unchanged when only the tail past the top-N accessible churns', () => {
    const known = ['c:1']; // c inaccessible -> top-10 accessible pulls in k, l stays unused
    const before = skipKey(pool('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'), known);
    const after = skipKey(pool('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'z'), known); // unused l -> z
    expect(after).toBe(before);
  });

  it('changes when an accessible top-N parse changes', () => {
    const known = ['c:1'];
    const before = skipKey(pool('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'), known);
    const after = skipKey(pool('a', 'b', 'c', 'X', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'), known); // used d -> X
    expect(after).not.toBe(before);
  });

  it('recomputes, then stabilizes, when a new inaccessible log enters the top 10', () => {
    const stampN = stampAfterCompute(pool('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'), []);
    expect(stampN.inaccessible_parses).toEqual([]);

    // X (private) enters at rank 5, pushing j to rank 11.
    const poolN1 = pool('a', 'b', 'c', 'd', 'X', 'e', 'f', 'g', 'h', 'i', 'j');

    // The cheap check still uses last run's (empty) set, so the unknown X counts in the
    // top-10 and the key changes -> recompute fires.
    expect(skipKey(poolN1, stampN.inaccessible_parses)).not.toBe(stampN.signature);

    // The recompute fetches X, finds it inaccessible, persists it, and keys on the top-10
    // accessible - which is the original a..j, so the data and signature are unchanged.
    const stampN1 = stampAfterCompute(poolN1, ['X']);
    expect(stampN1.inaccessible_parses).toEqual(['X:1']);
    expect(stampN1.signature).toBe(stampN.signature);

    // Next run: X is now known-inaccessible, excluded by the cheap check -> SKIP.
    expect(skipKey(poolN1, stampN1.inaccessible_parses)).toBe(stampN1.signature);
  });

  it('recomputes when a new accessible log pushes the inaccessible 10th out of the top 10', () => {
    // T is rank 10 and inaccessible; u, v are the accessible tail (ranks 11-12).
    const poolA = pool('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'T', 'u', 'v');
    const stampA = stampAfterCompute(poolA, ['T']);
    expect(stampA.inaccessible_parses).toEqual(['T:1']);
    // u backfills the inaccessible 10th, so the data keys on a..i + u.
    expect(stampA.signature).toBe(sig(pool('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'u')));

    // Y (accessible) enters at rank 5, pushing T to rank 11 (out of the top 10).
    const poolB = pool('a', 'b', 'c', 'd', 'Y', 'e', 'f', 'g', 'h', 'i', 'T', 'u', 'v');

    // Top-10 accessible is now a..i + Y (u no longer needed) -> differs from stampA -> recompute.
    expect(skipKey(poolB, stampA.inaccessible_parses)).not.toBe(stampA.signature);

    // The recompute reaches 10 accessible without fetching T (now rank 11), so T is pruned
    // from the persisted set and the key is the plain top-10.
    const stampB = stampAfterCompute(poolB, []);
    expect(stampB.inaccessible_parses).toEqual([]);
    expect(stampB.signature).toBe(sig(pool('a', 'b', 'c', 'd', 'Y', 'e', 'f', 'g', 'h', 'i')));
    expect(skipKey(poolB, stampB.inaccessible_parses)).toBe(stampB.signature);
  });

  it('does not recompute when a new log enters below the top-N accessible', () => {
    const stampN = stampAfterCompute(pool('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'), []);
    // A new log lands at rank 11 - the top-10 accessible (a..j) is untouched, so SKIP.
    const poolN1 = pool('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'w');
    expect(skipKey(poolN1, stampN.inaccessible_parses)).toBe(stampN.signature);
  });

  it('excludes multiple known-inaccessible parses and keys on the next accessible ones', () => {
    // c and f (ranks 3, 6) inaccessible -> top-10 accessible pulls in k and l.
    const rows = pool('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l');
    expect(skipKey(rows, ['c:1', 'f:1'])).toBe(sig(pool('a', 'b', 'd', 'e', 'g', 'h', 'i', 'j', 'k', 'l')));
  });

  it('a top-N parse turning inaccessible is missed by the cheap check until a recompute (documented residual)', () => {
    // d is accessible at the last compute, so it is NOT in the persisted set; the key
    // includes it. If d later goes private with no ranking change, the cheap check - still
    // keyed on the same pool minus the same (d-free) known set - produces the same key and
    // SKIPS. The staleness self-heals only when the encounter recomputes for another reason.
    const rows = pool('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j');
    const stampN = stampAfterCompute(rows, []);
    expect(skipKey(rows, stampN.inaccessible_parses)).toBe(stampN.signature);
  });
});

describe('encounterSkipKey', () => {
  const P = (report_code: string): SignatureRanking => ({ report_code, fight_id: 1 });
  const pool = (...codes: string[]): SignatureRanking[] => codes.map(P);
  const VERSION = '1';
  const TOP_N = 3; // small N so the cases read as documentation, not a wall of fixtures

  it('with no inaccessible parses, equals the signature over the top-N pool', () => {
    const rows = pool('a', 'b', 'c', 'd');
    expect(encounterSkipKey(rows, new Set(), VERSION, TOP_N))
      .toBe(encounterSignature(VERSION, pool('a', 'b', 'c')));
  });

  it('excludes inaccessible keys before taking the top-N', () => {
    // b inaccessible -> the top-3 accessible parses are a, c, d
    expect(encounterSkipKey(pool('a', 'b', 'c', 'd'), new Set(['b:1']), VERSION, TOP_N))
      .toBe(encounterSignature(VERSION, pool('a', 'c', 'd')));
  });

  it('ignores a parse past the top-N accessible (strict slice boundary)', () => {
    const topN = encounterSkipKey(pool('a', 'b', 'c'), new Set(), VERSION, TOP_N);
    // a 4th parse beyond the top-3 must not change the key
    expect(encounterSkipKey(pool('a', 'b', 'c', 'd'), new Set(), VERSION, TOP_N)).toBe(topN);
  });
});

describe('signatureAfterFetch', () => {
  const P = (report_code: string): SignatureRanking => ({ report_code, fight_id: 1 });
  const pool = (...codes: string[]): SignatureRanking[] => codes.map(P);
  const VERSION = '1';
  const TOP_N = 3;

  it('maps inaccessible report codes to parse keys and signs the accessible top-N', () => {
    const rows = pool('a', 'b', 'c', 'd');
    const result = signatureAfterFetch(rows, new Set(['b']), VERSION, TOP_N);
    expect(result.inaccessibleParses).toEqual(['b:1']);
    expect(result.signature).toBe(encounterSkipKey(rows, new Set(['b:1']), VERSION, TOP_N));
  });

  it('returns no inaccessible parses when no code matches the pool', () => {
    const rows = pool('a', 'b', 'c');
    const result = signatureAfterFetch(rows, new Set(['zzz']), VERSION, TOP_N);
    expect(result.inaccessibleParses).toEqual([]);
    expect(result.signature).toBe(encounterSignature(VERSION, pool('a', 'b', 'c')));
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

describe('isFutureVersion', () => {
  const CURRENT = 6;

  it('flags a file stamped with a newer ingest version', () => {
    expect(isFutureVersion({ ingest_version: CURRENT + 1 }, CURRENT)).toBe(true);
  });

  it('passes a matching or older version', () => {
    expect(isFutureVersion({ ingest_version: CURRENT }, CURRENT)).toBe(false);
    expect(isFutureVersion({ ingest_version: CURRENT - 1 }, CURRENT)).toBe(false);
  });

  it('passes a file with no version stamp (manifest / rulebook)', () => {
    expect(isFutureVersion({ spec: 'X' }, CURRENT)).toBe(false);
    expect(isFutureVersion([{ spec: 'X' }], CURRENT)).toBe(false);
  });

  it('passes a non-object or a non-numeric version stamp', () => {
    expect(isFutureVersion(null, CURRENT)).toBe(false);
    expect(isFutureVersion('nope', CURRENT)).toBe(false);
    expect(isFutureVersion({ ingest_version: 'seven' }, CURRENT)).toBe(false);
    expect(isFutureVersion({ ingest_version: Number.NaN }, CURRENT)).toBe(false);
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

describe('stampBurstFile', () => {
  // The skip check reads only the burst file's source_signature: a stamped burst makes the next
  // run skip the encounter; an unstamped one makes it recompute (so a failed sibling is retried).
  const SIGNATURE = encounterSignature('1', rankings(['r1', 1]));
  const VERSION = 1;
  const INACCESSIBLE = ['r2:2'];
  const data = { spec: 'X', encounter_id: 1 };

  // Only .ok and .error.kind matter to the stamp, so the ok payload is a placeholder; the five
  // entries stand for burst, rotation, defensive, gear and map results.
  const OK: Result<unknown, LoadError> = ok('slice');
  const ALL_OK: Result<unknown, LoadError>[] = [OK, OK, OK, OK, OK];
  const withSibling = (sibling: Result<unknown, LoadError>): Result<unknown, LoadError>[] => [OK, sibling, OK, OK, OK];

  const nextRunSkips = (file: { source_signature?: string }): boolean =>
    signatureMatches(readStoredSignature(file), SIGNATURE);

  it('stamps the signature when every slice produced data, so the next run skips', () => {
    const file = stampBurstFile(data, SIGNATURE, VERSION, INACCESSIBLE, ALL_OK);
    expect(readStoredSignature(file)).toBe(SIGNATURE);
    expect(nextRunSkips(file)).toBe(true);
  });

  it('leaves the burst unstamped when a sibling slice fails transiently, so the next run redoes it', () => {
    const file = stampBurstFile(data, SIGNATURE, VERSION, INACCESSIBLE, withSibling(transient('WCL request failed')));
    expect(readStoredSignature(file)).toBeNull();
    expect(nextRunSkips(file)).toBe(false);
  });

  it('leaves the burst unstamped when a sibling slice fails permanently', () => {
    const file = stampBurstFile(data, SIGNATURE, VERSION, INACCESSIBLE, withSibling(permanent('bad shape', 'burst.bench')));
    expect(readStoredSignature(file)).toBeNull();
    expect(nextRunSkips(file)).toBe(false);
  });

  it('still stamps when a sibling is legitimately empty (missing is not a failure), so a valid encounter is not redone forever', () => {
    const file = stampBurstFile(data, SIGNATURE, VERSION, INACCESSIBLE, withSibling(missing('No top parses')));
    expect(readStoredSignature(file)).toBe(SIGNATURE);
    expect(nextRunSkips(file)).toBe(true);
  });

  it('persists the ingest version and the inaccessible set for the next cheap check, stamped or not', () => {
    const stamped = stampBurstFile(data, SIGNATURE, VERSION, INACCESSIBLE, ALL_OK);
    const unstamped = stampBurstFile(data, SIGNATURE, VERSION, INACCESSIBLE, withSibling(transient('WCL request failed')));
    for (const file of [stamped, unstamped]) {
      expect(readStoredVersion(file)).toBe(VERSION);
      expect(file.inaccessible_parses).toEqual(INACCESSIBLE);
    }
  });

  it('does not mutate the input data', () => {
    stampBurstFile(data, SIGNATURE, VERSION, INACCESSIBLE, ALL_OK);
    expect(data).not.toHaveProperty('source_signature');
    expect(data).not.toHaveProperty('ingest_version');
  });
});
