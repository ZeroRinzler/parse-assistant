import { describe, expect, it } from 'vitest';
import { ClipRoll, ClipWindow, Segment, LiveCaptureFeatureService } from './live-capture-feature-service';
import { ClipAnchor } from '../../../../domain/capture/capture.models';
import { TestBed } from '@angular/core/testing';
import { WCL_TRANSPORT } from '../../../../core/wcl/wcl-transport';
import { DATA_FILE_TRANSPORT } from '../../../../core/data-files/data-file-transport';

TestBed.configureTestingModule({ providers: [
  { provide: WCL_TRANSPORT, useValue: {} },
  { provide: DATA_FILE_TRANSPORT, useValue: { readJson: () => new Promise(() => undefined) } },
] });
const svc = TestBed.inject(LiveCaptureFeatureService);
TestBed.resetTestingModule();

const REPORT_START_MS = 1_700_000_000_000;
const FIGHT_START_MS = 60_000;
const WINDOW_TIME_S = 10;
const WINDOW_LENGTH_S = 6;
const ROLL: ClipRoll = { preMs: 5_000, postMs: 5_000 };

/** A blob-less segment stub - the pure fns only read the wall-clock bounds. */
function seg(startMs: number, endMs: number): Segment {
  return { start: startMs, end: endMs, blob: new Blob([]) };
}

function anchor(over: Partial<ClipAnchor> = {}): ClipAnchor {
  return { timeS: WINDOW_TIME_S, windowLengthS: WINDOW_LENGTH_S, key: 'w0', ...over };
}

describe('absoluteWindowStart', () => {
  it('adds the fight offset and the bench offset onto the report clock', () => {
    expect(svc['absoluteWindowStart'](REPORT_START_MS, FIGHT_START_MS, WINDOW_TIME_S)).toBe(REPORT_START_MS + 60_000 + 10_000);
  });

  it('maps offset 0 to the fight start on the report clock', () => {
    expect(svc['absoluteWindowStart'](REPORT_START_MS, FIGHT_START_MS, 0)).toBe(REPORT_START_MS + FIGHT_START_MS);
  });
});

describe('buildClipWindow', () => {
  it('widens the window by pre/post roll around its absolute span', () => {
    const absStart = REPORT_START_MS + FIGHT_START_MS + WINDOW_TIME_S * 1000;
    const window = svc['buildClipWindow'](REPORT_START_MS, FIGHT_START_MS, anchor(), ROLL);
    expect(window.fromMs).toBe(absStart - ROLL.preMs);
    expect(window.toMs).toBe(absStart + WINDOW_LENGTH_S * 1000 + ROLL.postMs);
  });

  it('carries the window key through unchanged', () => {
    expect(svc['buildClipWindow'](REPORT_START_MS, FIGHT_START_MS, anchor({ key: 'def3' }), ROLL).key).toBe('def3');
  });
});

describe('fullPullWindow', () => {
  // A fight ending 5 minutes after it starts on the report clock.
  const FIGHT_END_MS = FIGHT_START_MS + 5 * 60 * 1000;

  it('spans the whole fight on the report clock', () => {
    const window = svc['fullPullWindow'](REPORT_START_MS, FIGHT_START_MS, FIGHT_END_MS);
    expect(window.fromMs).toBe(REPORT_START_MS + FIGHT_START_MS);
    expect(window.toMs).toBe(REPORT_START_MS + FIGHT_END_MS);
  });

  it('keys the window so its clip is distinct from any bench window', () => {
    expect(svc['fullPullWindow'](REPORT_START_MS, FIGHT_START_MS, FIGHT_END_MS).key).toBe('full-pull');
  });
});

describe('selectSegments', () => {
  const window: ClipWindow = { fromMs: 100, toMs: 200, key: 'w0' };

  it('returns only the segments overlapping the window, sorted by start', () => {
    const before = seg(0, 90);
    const overlapLeft = seg(50, 150);
    const inside = seg(150, 180);
    const after = seg(210, 260);
    const selected = svc['selectSegments']([after, inside, overlapLeft, before], window);
    expect(selected).toEqual([overlapLeft, inside]);
  });

  it('excludes a segment that only touches the window edge (strict overlap)', () => {
    const endsAtStart = seg(0, 100); // end == fromMs
    const startsAtEnd = seg(200, 300); // start == toMs
    expect(svc['selectSegments']([endsAtStart, startsAtEnd], window)).toEqual([]);
  });

  it('returns [] when nothing overlaps', () => {
    expect(svc['selectSegments']([], window)).toEqual([]);
  });
});

describe('segmentSeekOffset', () => {
  const window: ClipWindow = { fromMs: 12_000, toMs: 20_000, key: 'w0' };

  it('is the seconds from the first segment start to the window start', () => {
    // window starts 2s into a segment that began at 10_000
    expect(svc['segmentSeekOffset'](window, seg(10_000, 13_000))).toBe(2);
  });

  it('clamps to 0 when the window starts before the first segment', () => {
    expect(svc['segmentSeekOffset'](window, seg(13_000, 16_000))).toBe(0);
  });

  it('is 0 when there is no first segment', () => {
    expect(svc['segmentSeekOffset'](window, undefined)).toBe(0);
  });
});

describe('interSegmentGapMs', () => {
  it('sums the wall-clock gaps between consecutive segments (the recorder restarts)', () => {
    // 100ms lost between segments 0 and 1, 50ms between 1 and 2.
    expect(svc['interSegmentGapMs']([seg(0, 3_000), seg(3_100, 6_100), seg(6_150, 9_150)])).toBe(150);
  });

  it('is 0 for back-to-back segments', () => {
    expect(svc['interSegmentGapMs']([seg(0, 3_000), seg(3_000, 6_000)])).toBe(0);
  });

  it('is 0 for a single segment and for none', () => {
    expect(svc['interSegmentGapMs']([seg(0, 3_000)])).toBe(0);
    expect(svc['interSegmentGapMs']([])).toBe(0);
  });
});

describe('segmentsCover', () => {
  it('is true when a segment overlaps the span', () => {
    expect(svc['segmentsCover']([seg(100, 200)], 150, 300)).toBe(true);
  });

  it('is false when every segment is disjoint from the span (report not recorded here)', () => {
    expect(svc['segmentsCover']([seg(100, 200)], 500, 900)).toBe(false);
  });

  it('is false for an empty buffer', () => {
    expect(svc['segmentsCover']([], 0, 1_000)).toBe(false);
  });
});
