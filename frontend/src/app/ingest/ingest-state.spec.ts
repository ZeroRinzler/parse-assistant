import { describe, it, expect } from 'vitest';
import {
  readIngestState, nextIngestState, prunedIngestState, encounterIdsFromFiles,
  type SpecIngestState,
} from './ingest-state';
import { type IngestStamp } from './stamp';

const NEKZALI = 3470;
const ENTOMBED_SENTINELS = 3445;
const PHASED_OUT_BOSS = 3181;

const STAMP: IngestStamp = { version: 26, ingestedAtS: 1787332065 };
const EARLIER: IngestStamp = { version: 25, ingestedAtS: 1787000000 };

const state = (over: Partial<SpecIngestState> = {}): SpecIngestState => ({
  ingest_version: EARLIER.version,
  ingested_at_s: EARLIER.ingestedAtS,
  empty_encounter_ids: [NEKZALI],
  ...over,
});

const NOTHING_BENCHED: ReadonlySet<number> = new Set();
const NOTHING_CHECKED: readonly number[] = [];

describe('readIngestState', () => {
  it('reads a well-formed marker', () => {
    expect(readIngestState({ ...state() })).toEqual(state());
  });

  it('reads a marker that lists no empty encounter', () => {
    expect(readIngestState({ ...state({ empty_encounter_ids: [] }) }))
      .toEqual(state({ empty_encounter_ids: [] }));
  });

  it('reads a marker whose id list is not an array as no marker', () => {
    expect(readIngestState({ ...state(), empty_encounter_ids: NEKZALI })).toBeNull();
  });

  it('reads a marker with no ingest version as no marker', () => {
    expect(readIngestState({ ingested_at_s: EARLIER.ingestedAtS, empty_encounter_ids: [NEKZALI] })).toBeNull();
  });

  it('reads a missing file as no marker', () => {
    expect(readIngestState(null)).toBeNull();
  });
});

describe('nextIngestState', () => {
  it('marks an encounter this pass checked and found no parses for', () => {
    expect(nextIngestState(null, [NEKZALI], NOTHING_BENCHED, STAMP).empty_encounter_ids).toEqual([NEKZALI]);
  });

  it('does not mark an encounter this pass checked that produced a bench', () => {
    expect(nextIngestState(null, [NEKZALI], new Set([NEKZALI]), STAMP).empty_encounter_ids).toEqual([]);
  });

  it('clears a previously marked encounter that now has a bench', () => {
    expect(nextIngestState(state(), NOTHING_CHECKED, new Set([NEKZALI]), STAMP).empty_encounter_ids).toEqual([]);
  });

  it('keeps a previously marked encounter the pass never reached', () => {
    expect(nextIngestState(state(), NOTHING_CHECKED, NOTHING_BENCHED, STAMP).empty_encounter_ids).toEqual([NEKZALI]);
  });

  it('lists each encounter once, ascending, when a marked one is checked again', () => {
    expect(nextIngestState(state(), [ENTOMBED_SENTINELS, NEKZALI], NOTHING_BENCHED, STAMP).empty_encounter_ids)
      .toEqual([ENTOMBED_SENTINELS, NEKZALI]);
  });

  it('carries the version and time of the run that wrote it', () => {
    const next = nextIngestState(state(), NOTHING_CHECKED, NOTHING_BENCHED, STAMP);
    expect(next.ingest_version).toBe(STAMP.version);
    expect(next.ingested_at_s).toBe(STAMP.ingestedAtS);
  });

  it('marks nothing for a spec with no marker and no encounter checked', () => {
    expect(nextIngestState(null, NOTHING_CHECKED, NOTHING_BENCHED, STAMP).empty_encounter_ids).toEqual([]);
  });
});

describe('prunedIngestState', () => {
  it('drops an encounter the current zone no longer carries', () => {
    const previous = state({ empty_encounter_ids: [PHASED_OUT_BOSS, NEKZALI] });
    expect(prunedIngestState(previous, new Set([NEKZALI]))?.empty_encounter_ids).toEqual([NEKZALI]);
  });

  it('writes nothing when every marked encounter is still in the current zone', () => {
    expect(prunedIngestState(state(), new Set([NEKZALI]))).toBeNull();
  });

  it('writes nothing for a spec with no marker', () => {
    expect(prunedIngestState(null, new Set([NEKZALI]))).toBeNull();
  });

  it('keeps the version and time of the run that last checked the spec', () => {
    const previous = state({ empty_encounter_ids: [PHASED_OUT_BOSS, NEKZALI] });
    const pruned = prunedIngestState(previous, new Set([NEKZALI]));
    expect(pruned?.ingest_version).toBe(EARLIER.version);
    expect(pruned?.ingested_at_s).toBe(EARLIER.ingestedAtS);
  });
});

describe('encounterIdsFromFiles', () => {
  // "10.json" sorts before "9.json" lexicographically; these ids pin the numeric order.
  const LOW_ID = 9;
  const HIGH_ID = 10;

  it('reads ids in numeric order', () => {
    expect(encounterIdsFromFiles([`${HIGH_ID}.json`, `${LOW_ID}.json`])).toEqual([LOW_ID, HIGH_ID]);
  });

  it('reads an encounter id from a bench filename', () => {
    expect(encounterIdsFromFiles([`${NEKZALI}.json`])).toEqual([NEKZALI]);
  });

  it('skips a crashed temp write, a non-numeric name, and a non-json file', () => {
    expect(encounterIdsFromFiles([`${NEKZALI}.json.7.0.tmp`, 'rulebook.json', '.gitkeep'])).toEqual([]);
  });
});
