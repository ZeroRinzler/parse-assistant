import { describe, expect, it } from 'vitest';
import {
  ClipRoll, ClipWindow, Segment,
  absoluteWindowStart, buildClipWindows, interSegmentGapMs, segmentSeekOffset, segmentsCover, selectSegments,
} from './live-capture.service';
import { ClipAnchor } from '../../../core/models/capture.models';

// A fixed report clock (unix epoch ms) and a fight starting one minute into the report,
// so the absolute mapping report + fight + offset is easy to read by eye.
const REPORT_START_MS = 1_700_000_000_000;
const FIGHT_START_MS = 60_000;
// Bench window: opens 10s into the fight and lasts 6s (a burst window).
const WINDOW_TIME_S = 10;
const WINDOW_LENGTH_S = 6;
// 5s of lead-in and 5s of tail around each window.
const ROLL: ClipRoll = { preMs: 5_000, postMs: 5_000 };

/** A blob-less segment stub - the pure fns only read the wall-clock bounds. */
function seg(idx: number, startMs: number, endMs: number): Segment {
  return { idx, start: startMs, end: endMs, blob: new Blob([]) };
}

function anchor(over: Partial<ClipAnchor> = {}): ClipAnchor {
  return { timeS: WINDOW_TIME_S, windowLengthS: WINDOW_LENGTH_S, key: 'w0', ...over };
}

describe('absoluteWindowStart', () => {
  it('adds the fight offset and the bench offset onto the report clock', () => {
    // 1_700_000_000_000 + 60_000 + 10 * 1000
    expect(absoluteWindowStart(REPORT_START_MS, FIGHT_START_MS, WINDOW_TIME_S)).toBe(REPORT_START_MS + 60_000 + 10_000);
  });

  it('maps offset 0 to the fight start on the report clock', () => {
    expect(absoluteWindowStart(REPORT_START_MS, FIGHT_START_MS, 0)).toBe(REPORT_START_MS + FIGHT_START_MS);
  });
});

describe('buildClipWindows', () => {
  it('widens each window by pre/post roll around its absolute span', () => {
    const absStart = REPORT_START_MS + FIGHT_START_MS + WINDOW_TIME_S * 1000;
    const [window] = buildClipWindows(REPORT_START_MS, FIGHT_START_MS, [anchor()], ROLL);
    expect(window.fromMs).toBe(absStart - ROLL.preMs);
    expect(window.toMs).toBe(absStart + WINDOW_LENGTH_S * 1000 + ROLL.postMs);
  });

  it('carries each window key through unchanged', () => {
    const [window] = buildClipWindows(REPORT_START_MS, FIGHT_START_MS, [anchor({ key: 'def3' })], ROLL);
    expect(window.key).toBe('def3');
  });

  it('keeps one clip per window rather than merging them', () => {
    const windows = buildClipWindows(REPORT_START_MS, FIGHT_START_MS, [anchor({ key: 'a' }), anchor({ key: 'b', timeS: 11 })], ROLL);
    expect(windows.map(w => w.key)).toEqual(['a', 'b']);
  });

  it('returns [] for no windows', () => {
    expect(buildClipWindows(REPORT_START_MS, FIGHT_START_MS, [], ROLL)).toEqual([]);
  });
});

describe('selectSegments', () => {
  const window: ClipWindow = { fromMs: 100, toMs: 200, key: 'w0' };

  it('returns only the segments overlapping the window, sorted by start', () => {
    const before = seg(0, 0, 90);
    const overlapLeft = seg(1, 50, 150);
    const inside = seg(2, 150, 180);
    const after = seg(3, 210, 260);
    const selected = selectSegments([after, inside, overlapLeft, before], window);
    expect(selected.map(s => s.idx)).toEqual([1, 2]);
  });

  it('excludes a segment that only touches the window edge (strict overlap)', () => {
    const endsAtStart = seg(0, 0, 100); // end == fromMs
    const startsAtEnd = seg(1, 200, 300); // start == toMs
    expect(selectSegments([endsAtStart, startsAtEnd], window)).toEqual([]);
  });

  it('returns [] when nothing overlaps', () => {
    expect(selectSegments([], window)).toEqual([]);
  });
});

describe('segmentSeekOffset', () => {
  const window: ClipWindow = { fromMs: 12_000, toMs: 20_000, key: 'w0' };

  it('is the seconds from the first segment start to the window start', () => {
    // window starts 2s into a segment that began at 10_000
    expect(segmentSeekOffset(window, seg(0, 10_000, 13_000))).toBe(2);
  });

  it('clamps to 0 when the window starts before the first segment', () => {
    expect(segmentSeekOffset(window, seg(0, 13_000, 16_000))).toBe(0);
  });

  it('is 0 when there is no first segment', () => {
    expect(segmentSeekOffset(window, undefined)).toBe(0);
  });
});

describe('interSegmentGapMs', () => {
  it('sums the wall-clock gaps between consecutive segments (the recorder restarts)', () => {
    // 100ms lost between segments 0 and 1, 50ms between 1 and 2.
    expect(interSegmentGapMs([seg(0, 0, 3_000), seg(1, 3_100, 6_100), seg(2, 6_150, 9_150)])).toBe(150);
  });

  it('is 0 for back-to-back segments', () => {
    expect(interSegmentGapMs([seg(0, 0, 3_000), seg(1, 3_000, 6_000)])).toBe(0);
  });

  it('is 0 for a single segment and for none', () => {
    expect(interSegmentGapMs([seg(0, 0, 3_000)])).toBe(0);
    expect(interSegmentGapMs([])).toBe(0);
  });
});

describe('segmentsCover', () => {
  it('is true when a segment overlaps the span', () => {
    expect(segmentsCover([seg(0, 100, 200)], 150, 300)).toBe(true);
  });

  it('is false when every segment is disjoint from the span (report not recorded here)', () => {
    expect(segmentsCover([seg(0, 100, 200)], 500, 900)).toBe(false);
  });

  it('is false for an empty buffer', () => {
    expect(segmentsCover([], 0, 1_000)).toBe(false);
  });
});
