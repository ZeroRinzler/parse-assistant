import { getOrInsert } from './analysis-math';
import { TimedEvent, targetKey } from './wcl-projections';

/** Fight-relative seconds; an open end means the aura outlived the fight. */
export type AuraWindows = Map<number, [number, number | null][]>;

function lastOpen(spans: [number, number | null][]): [number, number | null] | undefined {
  for (let i = spans.length - 1; i >= 0; i--) {
    if (spans[i][1] == null) return spans[i];
  }
  return undefined;
}

/** Buffs and debuffs carry the same apply/remove shape, so one call covers either stream. */
export function buildAuraWindows(events: TimedEvent[]): AuraWindows {
  const windows: AuraWindows = new Map();
  for (const event of events) {
    const spellId = event.abilityGameID;
    if (spellId == null) continue;
    const timeS = event.atS;
    if (event.type === 'applybuff' || event.type === 'applydebuff') {
      getOrInsert(windows, spellId, () => []).push([timeS, null]);
    // WCL emits no synthetic apply for an aura already up at the pull, so a bare remove or refresh is the only trace it leaves.
    } else if (event.type === 'removebuff' || event.type === 'removedebuff') {
      const spans = getOrInsert(windows, spellId, () => []);
      const open = lastOpen(spans);
      if (open) open[1] = timeS; else spans.push([0, timeS]);
    } else if (event.type === 'refreshbuff' || event.type === 'refreshdebuff') {
      const spans = getOrInsert(windows, spellId, () => []);
      if (!lastOpen(spans)) spans.push([0, null]);
    }
  }
  return windows;
}

/** Up at that instant, both edges counted: a consuming cast shares the removal second 38% of the time. */
export function auraUpAt(windows: AuraWindows, spellId: number, timeS: number): boolean {
  return (windows.get(spellId) ?? []).some(([start, end]) => timeS >= start && (end == null || timeS <= end));
}

/** Up going INTO that instant: the cast that grants a state shares its applybuff timestamp, which `auraUpAt` would credit it with. */
export function auraAlreadyUpAt(windows: AuraWindows, spellId: number, timeS: number): boolean {
  return (windows.get(spellId) ?? []).some(([start, end]) => timeS > start && (end == null || timeS <= end));
}

/** groundedFromStart is false when the first entry is a bare remove or stack event rather than an apply, meaning nothing before it is known. */
export interface StackTimeline {
  readonly groundedFromStart: boolean;
  readonly entries: readonly [number, number][];
}

/** A bare apply carries no count and means one; every stack event carries the new total, clamped so a reported drop below zero cannot leak through. */
export function buildStackTimeline(events: TimedEvent[], spellId: number): StackTimeline {
  const entries: [number, number][] = [];
  let groundedFromStart = false;
  for (const event of events) {
    if (event.abilityGameID !== spellId) continue;
    const timeS = event.atS;
    if (event.type === 'applybuff' || event.type === 'applydebuff') {
      if (!entries.length) groundedFromStart = true;
      entries.push([timeS, Math.max(0, event.stack ?? 1)]);
    } else if (event.type.endsWith('buffstack') || event.type.endsWith('debuffstack')) {
      entries.push([timeS, Math.max(0, event.stack ?? 0)]);
    } else if (event.type === 'removebuff' || event.type === 'removedebuff') {
      entries.push([timeS, 0]);
    }
  }
  return { groundedFromStart, entries };
}

/** The count in force going INTO that moment, or null when `groundedFromStart` is false and nothing earlier is known; WCL logs a consuming cast and the stack it spends on one timestamp, so a same-instant change belongs to the cast rather than preceding it. */
export function stacksAt(timeline: StackTimeline, timeS: number): number | null {
  let count: number | null = timeline.groundedFromStart ? 0 : null;
  for (const [at, value] of timeline.entries) {
    if (at >= timeS) break;
    count = value;
  }
  return count;
}

/** One unbroken application on one target. `endedByRefresh` separates a re-application from an expiry, which read the same in the stream. */
export interface AuraSpan {
  startS: number;
  endS: number | null;
  endedByRefresh: boolean;
}

/** One aura's spans per target, since a clip is only visible against the application it replaced. */
export type AuraSpansByTarget = Map<string, AuraSpan[]>;

export function buildAuraSpansByTarget(events: TimedEvent[], spellId: number): AuraSpansByTarget {
  const spans: AuraSpansByTarget = new Map();
  for (const event of events) {
    if (event.abilityGameID !== spellId) continue;
    const timeS = event.atS;
    const list = getOrInsert(spans, targetKey(event), (): AuraSpan[] => []);
    const open = list.length && list[list.length - 1].endS == null ? list[list.length - 1] : null;
    if (event.type === 'applybuff' || event.type === 'applydebuff') {
      if (!open) list.push({ startS: timeS, endS: null, endedByRefresh: false });
    } else if (event.type === 'refreshbuff' || event.type === 'refreshdebuff') {
      if (open) { open.endS = timeS; open.endedByRefresh = true; }
      list.push({ startS: timeS, endS: null, endedByRefresh: false });
    } else if (event.type === 'removebuff' || event.type === 'removedebuff') {
      if (open) open.endS = timeS;
    }
  }
  return spans;
}

/** Percentage of the fight the aura was up. Overlapping spans are merged, so multi-target debuffs read as "up somewhere", which is what a maintain rule means. */
export function auraUptimePct(windows: AuraWindows, spellId: number, fightDurationS: number): number {
  if (fightDurationS <= 0) return 0;
  const spans = (windows.get(spellId) ?? [])
    .map(([start, end]): [number, number] => [Math.max(0, start), Math.min(fightDurationS, end ?? fightDurationS)])
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] - b[0]);
  let covered = 0;
  let cursor = -1;
  for (const [start, end] of spans) {
    const from = Math.max(start, cursor);
    if (end > from) { covered += end - from; cursor = end; }
  }
  return (covered / fightDurationS) * 100;
}
