import { describe, it, expect } from 'vitest';
import { type Result, Results } from '../../../../core/http/result';
import { INGEST_VERSION } from './ingest-version';
import { type SignatureRanking, IngestSignatureService } from './ingest-signature-service';
import { type IngestStamp, IngestStampService } from './ingest-stamp-service';
import { TestBed } from '@angular/core/testing';

const signatures = TestBed.inject(IngestSignatureService);
const stamps = TestBed.inject(IngestStampService);

const INGESTED_AT_S = 1776245400;
const STAMP: IngestStamp = { version: INGEST_VERSION, ingestedAtS: INGESTED_AT_S };
const VERSION = String(INGEST_VERSION);
const TOP_N = 10;
const PRIVATE_RANK = 1;
const ranking = (rank: number): SignatureRanking => ({ report_code: `report${rank}`, fight_id: rank });
const ROWS = [PRIVATE_RANK, 2, 3].map(ranking);
// Spelled out rather than imported: baked files carry this key, so importing its producer would let a format change pass.
const PRIVATE_PARSE = `report${PRIVATE_RANK}:${PRIVATE_RANK}`;
const SIGNATURE = signatures.encounterSkipKey(ROWS, new Set(), VERSION, TOP_N);
const WITHOUT_PRIVATE = signatures.encounterSkipKey(ROWS, new Set([PRIVATE_PARSE]), VERSION, TOP_N);
const DATA = { spec: 'SubtletyRogue', encounter_id: 3470 };
const NO_INACCESSIBLE: string[] = [];

// Only .ok and .error.kind matter to the stamp, so the ok payload is a placeholder.
const OK: Result<unknown> = Results.ok('slice');
const ALL_OK: Result<unknown>[] = [OK, OK, OK, OK, OK];
const withSibling = (sibling: Result<unknown>): Result<unknown>[] => [OK, sibling, OK, OK, OK];
const nextRun = (file: unknown): { skip: boolean; signature: string } => stamps.skipDecision(file, ROWS, VERSION, TOP_N);

describe('write then read', () => {
  it('skips an encounter whose file this run stamped for the same parse set', () => {
    const file = stamps.stampSignature(DATA, SIGNATURE, STAMP);

    expect(nextRun(file)).toEqual({ skip: true, signature: SIGNATURE });
  });

  it('skips an encounter whose burst every slice completed', () => {
    const file = stamps.stampBurstFile(DATA, SIGNATURE, STAMP, NO_INACCESSIBLE, ALL_OK);

    expect(nextRun(file)).toEqual({ skip: true, signature: SIGNATURE });
  });

  it('still skips when a sibling slice is legitimately empty (missing is not a failure)', () => {
    const file = stamps.stampBurstFile(DATA, SIGNATURE, STAMP, NO_INACCESSIBLE, withSibling(Results.missing('No top parses')));

    expect(nextRun(file)).toEqual({ skip: true, signature: SIGNATURE });
  });

  it('ingests an encounter with no file yet', () => {
    expect(nextRun(null)).toEqual({ skip: false, signature: SIGNATURE });
    expect(nextRun(undefined)).toEqual({ skip: false, signature: SIGNATURE });
    expect(nextRun({})).toEqual({ skip: false, signature: SIGNATURE });
  });

  it('ingests an encounter whose burst a transiently failed slice left unstamped', () => {
    const file = stamps.stampBurstFile(DATA, SIGNATURE, STAMP, NO_INACCESSIBLE, withSibling(Results.transient('WCL request failed')));

    expect(nextRun(file)).toEqual({ skip: false, signature: SIGNATURE });
  });

  it('ingests an encounter whose burst a permanently failed slice left unstamped', () => {
    const failed = withSibling(Results.permanent('bad shape', 'burst.bench'));
    const file = stamps.stampBurstFile(DATA, SIGNATURE, STAMP, NO_INACCESSIBLE, failed);

    expect(nextRun(file)).toEqual({ skip: false, signature: SIGNATURE });
  });

  it('ingests an encounter whose parse set gained a parse', () => {
    const file = stamps.stampSignature(DATA, SIGNATURE, STAMP);
    const grown = [...ROWS, ranking(4)];

    expect(stamps.skipDecision(file, grown, VERSION, TOP_N).skip).toBe(false);
  });

  it('skips a burst stamped without a parse it recorded as inaccessible', () => {
    const file = stamps.stampBurstFile(DATA, WITHOUT_PRIVATE, STAMP, [PRIVATE_PARSE], ALL_OK);

    expect(nextRun(file)).toEqual({ skip: true, signature: WITHOUT_PRIVATE });
  });

  it('ingests a file carrying that same signature without the inaccessible parse recorded', () => {
    const file = stamps.stampSignature(DATA, WITHOUT_PRIVATE, STAMP);

    expect(nextRun(file)).toEqual({ skip: false, signature: SIGNATURE });
  });

  it('writes the field names the files already on disk carry', () => {
    expect(stamps.stampSignature(DATA, SIGNATURE, STAMP)).toEqual({
      ...DATA, source_signature: SIGNATURE, ingest_version: INGEST_VERSION, ingested_at_s: INGESTED_AT_S,
    });
    expect(stamps.stampBurstFile(DATA, SIGNATURE, STAMP, [PRIVATE_PARSE], ALL_OK)).toEqual({
      ...DATA, source_signature: SIGNATURE, ingest_version: INGEST_VERSION,
      ingested_at_s: INGESTED_AT_S, inaccessible_parses: [PRIVATE_PARSE],
    });
  });

  it('reads the ingest version and stamp time back off either writer, stamped or not', () => {
    const tailored = stamps.stampSignature(DATA, SIGNATURE, STAMP);
    const unstamped = stamps.stampBurstFile(
      DATA, SIGNATURE, STAMP, [PRIVATE_PARSE], withSibling(Results.transient('WCL request failed')));

    for (const file of [tailored, unstamped]) {
      expect(stamps.readFileStamp(file)).toEqual({ version: INGEST_VERSION, ingestedAtS: INGESTED_AT_S });
    }
  });

  it('reads no version and no stamp time off an absent or unstamped file', () => {
    const UNSTAMPED = { version: null, ingestedAtS: null };

    expect(stamps.readFileStamp(null)).toEqual(UNSTAMPED);
    expect(stamps.readFileStamp(undefined)).toEqual(UNSTAMPED);
    expect(stamps.readFileStamp({})).toEqual(UNSTAMPED);
  });

  it('reads version 0 rather than defaulting it away', () => {
    expect(stamps.readFileStamp({ ingest_version: 0 }).version).toBe(0);
  });

  it('leaves the data the writers were handed untouched', () => {
    stamps.stampSignature(DATA, SIGNATURE, STAMP);
    stamps.stampBurstFile(DATA, SIGNATURE, STAMP, [PRIVATE_PARSE], ALL_OK);

    expect(DATA).toEqual({ spec: 'SubtletyRogue', encounter_id: 3470 });
  });
});

describe('version trust', () => {
  it('rejects a file stamped one ingest version ahead', () => {
    expect(stamps.isFutureVersion({ ingest_version: INGEST_VERSION + 1 })).toBe(true);
  });

  it('trusts the current version and an older one', () => {
    expect(stamps.isFutureVersion({ ingest_version: INGEST_VERSION })).toBe(false);
    expect(stamps.isFutureVersion({ ingest_version: INGEST_VERSION - 1 })).toBe(false);
  });

  it('trusts a file this run stamped', () => {
    expect(stamps.isFutureVersion(stamps.stampSignature(DATA, SIGNATURE, STAMP))).toBe(false);
    expect(stamps.isFutureVersion(stamps.stampBurstFile(DATA, SIGNATURE, STAMP, NO_INACCESSIBLE, ALL_OK))).toBe(false);
  });

  it('trusts a file with no version stamp (manifest / rulebook)', () => {
    expect(stamps.isFutureVersion({ spec: 'SubtletyRogue' })).toBe(false);
    expect(stamps.isFutureVersion([{ spec: 'SubtletyRogue' }])).toBe(false);
  });

  it('trusts a non-object or a non-numeric version stamp', () => {
    expect(stamps.isFutureVersion(null)).toBe(false);
    expect(stamps.isFutureVersion('nope')).toBe(false);
    expect(stamps.isFutureVersion({ ingest_version: 'seven' })).toBe(false);
    expect(stamps.isFutureVersion({ ingest_version: Number.NaN })).toBe(false);
  });
});
