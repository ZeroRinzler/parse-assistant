import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { DOCUMENT } from '@angular/common';
import { Subscription, exhaustMap, timer } from 'rxjs';
import { LiveReportSyncService, POLL_INTERVAL_S } from './live-report-sync';

/** vi's fake timers and Date.now() are ms-only; this is the one conversion point. */
const ms = (s: number) => s * 1000;

/** Half an interval: a delay clearly shorter than the refocus cooldown. */
const HALF_INTERVAL_S = POLL_INTERVAL_S / 2;

/** An inner poll that outlasts one interval, so the next scheduled tick overlaps it (proves exhaustMap drops it). */
const INNER_POLL_DURATION_S = POLL_INTERVAL_S + HALF_INTERVAL_S;

/** Base clock chosen so the very first refocus (with lastEmit still 0) already clears the cooldown. */
const START_TIME_S = POLL_INTERVAL_S;

/** A minimal DOCUMENT stand-in: a real EventTarget plus a settable visibilityState. */
class FakeDocument extends EventTarget {
  visibilityState: DocumentVisibilityState = 'visible';

  setVisible(visible: boolean): void {
    this.visibilityState = visible ? 'visible' : 'hidden';
  }

  fireVisibilityChange(): void {
    this.dispatchEvent(new Event('visibilitychange'));
  }
}

function setup(): { service: LiveReportSyncService; doc: FakeDocument } {
  const doc = new FakeDocument();
  TestBed.configureTestingModule({
    providers: [
      LiveReportSyncService,
      { provide: DOCUMENT, useValue: doc as unknown as Document },
    ],
  });
  return { service: TestBed.inject(LiveReportSyncService), doc };
}

describe('LiveReportSyncService pollTriggers', () => {
  let sub: Subscription | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(ms(START_TIME_S));
  });

  afterEach(() => {
    sub?.unsubscribe();
    sub = undefined;
    vi.useRealTimers();
  });

  it('does not emit immediately on subscription', () => {
    const { service } = setup();
    let emissions = 0;

    sub = service.pollTriggers().subscribe(() => emissions++);

    expect(emissions).toBe(0);
  });

  it('emits one tick per interval while the tab is visible', () => {
    const { service } = setup();
    let emissions = 0;
    sub = service.pollTriggers().subscribe(() => emissions++);

    vi.advanceTimersByTime(ms(POLL_INTERVAL_S));
    expect(emissions).toBe(1);

    vi.advanceTimersByTime(ms(POLL_INTERVAL_S));
    expect(emissions).toBe(2);

    vi.advanceTimersByTime(ms(POLL_INTERVAL_S));
    expect(emissions).toBe(3);
  });

  it('suppresses scheduled ticks while the tab is hidden and resumes when visible', () => {
    const { service, doc } = setup();
    let emissions = 0;
    sub = service.pollTriggers().subscribe(() => emissions++);

    doc.setVisible(false);
    vi.advanceTimersByTime(ms(POLL_INTERVAL_S * 3));
    expect(emissions).toBe(0);

    doc.setVisible(true);
    vi.advanceTimersByTime(ms(POLL_INTERVAL_S));
    expect(emissions).toBe(1);
  });

  it('honors the interval cooldown between the last emission and a refocus tick', () => {
    const { service, doc } = setup();
    let emissions = 0;
    // Advance time only while hidden so scheduled interval ticks stay filtered and the assertions isolate refocus behavior.
    sub = service.pollTriggers().subscribe(() => emissions++);
    doc.setVisible(false);

    // First refocus: cooldown already satisfied (lastEmit is 0), so it emits.
    doc.setVisible(true);
    doc.fireVisibilityChange();
    expect(emissions).toBe(1);
    doc.setVisible(false);

    // Refocus half an interval later: inside the cooldown, so it is dropped.
    vi.advanceTimersByTime(ms(HALF_INTERVAL_S));
    doc.setVisible(true);
    doc.fireVisibilityChange();
    expect(emissions).toBe(1);
    doc.setVisible(false);

    // Refocus a full interval after the last emission: cooldown elapsed, so it emits.
    vi.advanceTimersByTime(ms(HALF_INTERVAL_S));
    doc.setVisible(true);
    doc.fireVisibilityChange();
    expect(emissions).toBe(2);
  });

  it('drops overlapping polls when piped through exhaustMap', () => {
    const { service } = setup();
    let innerStarts = 0;
    sub = service
      .pollTriggers()
      .pipe(exhaustMap(() => { innerStarts++; return timer(ms(INNER_POLL_DURATION_S)); }))
      .subscribe();

    // Tick 1 starts an inner poll that runs 1.5 intervals.
    vi.advanceTimersByTime(ms(POLL_INTERVAL_S));
    // Tick 2 arrives while that inner poll is still running: exhaustMap drops it.
    vi.advanceTimersByTime(ms(POLL_INTERVAL_S));
    // Tick 3 arrives after the inner poll completed: a new inner poll starts.
    vi.advanceTimersByTime(ms(POLL_INTERVAL_S));

    expect(innerStarts).toBe(2);
  });

  it('stops polling and detaches the refocus listener on teardown', () => {
    const { service, doc } = setup();
    let emissions = 0;
    sub = service.pollTriggers().subscribe(() => emissions++);

    vi.advanceTimersByTime(ms(POLL_INTERVAL_S));
    expect(emissions).toBe(1);

    sub.unsubscribe();
    vi.advanceTimersByTime(ms(POLL_INTERVAL_S * 3));
    doc.fireVisibilityChange();

    expect(emissions).toBe(1);
  });
});
