import { WclEvent } from '../../core/models/wcl.models';
import { getOrInsert } from './analysis-math';
import { targetKey } from './wcl-projections';

/** Fight-relative milliseconds; an open end means the aura outlived the fight. */
export type AuraWindows = Map<number, [number, number | null][]>;

/** Buffs and debuffs carry the same apply/remove shape, so one call covers either stream. */
export function buildAuraWindows(events: WclEvent[], fightStartMs: number): AuraWindows {
  const windows: AuraWindows = new Map();
  for (const event of events) {
    const spellId = event.abilityGameID;
    if (spellId == null) continue;
    const timeMs = event.timestamp - fightStartMs;
    if (event.type === 'applybuff' || event.type === 'applydebuff') {
      getOrInsert(windows, spellId, () => []).push([timeMs, null]);
    } else if (event.type === 'removebuff' || event.type === 'removedebuff') {
      const spans = windows.get(spellId) ?? [];
      for (let i = spans.length - 1; i >= 0; i--) {
        if (spans[i][1] == null) { spans[i][1] = timeMs; break; }
      }
    }
  }
  return windows;
}

/** Up at that instant, both edges counted: a consuming cast shares the removal millisecond 38% of the time. */
export function auraUpAt(windows: AuraWindows, spellId: number, timeMs: number): boolean {
  return (windows.get(spellId) ?? []).some(([start, end]) => timeMs >= start && (end == null || timeMs <= end));
}

/** Up going INTO that instant: the cast that grants a state shares its applybuff timestamp, which `auraUpAt` would credit it with. */
export function auraAlreadyUpAt(windows: AuraWindows, spellId: number, timeMs: number): boolean {
  return (windows.get(spellId) ?? []).some(([start, end]) => timeMs > start && (end == null || timeMs <= end));
}

/** One aura's stack changes as `[atMs, count]`, in order. */
export type StackTimeline = [number, number][];

/** A bare apply carries no count and means one; every stack event carries the new total. */
export function buildStackTimeline(events: WclEvent[], fightStartMs: number, spellId: number): StackTimeline {
  const timeline: StackTimeline = [];
  for (const event of events) {
    if (event.abilityGameID !== spellId) continue;
    const timeMs = event.timestamp - fightStartMs;
    if (event.type === 'applybuff' || event.type === 'applydebuff') timeline.push([timeMs, event.stack ?? 1]);
    else if (event.type.endsWith('buffstack') || event.type.endsWith('debuffstack')) timeline.push([timeMs, event.stack ?? 0]);
    else if (event.type === 'removebuff' || event.type === 'removedebuff') timeline.push([timeMs, 0]);
  }
  return timeline;
}

/** The count in force going INTO that moment: WCL logs a consuming cast and the stack it spends on one timestamp, so a same-millisecond change belongs to the cast rather than preceding it. */
export function stacksAt(timeline: StackTimeline, timeMs: number): number {
  let count = 0;
  for (const [at, value] of timeline) {
    if (at >= timeMs) break;
    count = value;
  }
  return count;
}

/** One unbroken application on one target. `endedByRefresh` separates a re-application from an expiry, which read the same in the stream. */
export interface AuraSpan {
  startMs: number;
  endMs: number | null;
  endedByRefresh: boolean;
}

/** One aura's spans per target, since a clip is only visible against the application it replaced. */
export type AuraSpansByTarget = Map<string, AuraSpan[]>;

export function buildAuraSpansByTarget(events: WclEvent[], fightStartMs: number, spellId: number): AuraSpansByTarget {
  const spans: AuraSpansByTarget = new Map();
  for (const event of events) {
    if (event.abilityGameID !== spellId) continue;
    const timeMs = event.timestamp - fightStartMs;
    const list = getOrInsert(spans, targetKey(event), (): AuraSpan[] => []);
    const open = list.length && list[list.length - 1].endMs == null ? list[list.length - 1] : null;
    if (event.type === 'applybuff' || event.type === 'applydebuff') {
      if (!open) list.push({ startMs: timeMs, endMs: null, endedByRefresh: false });
    } else if (event.type === 'refreshbuff' || event.type === 'refreshdebuff') {
      if (open) { open.endMs = timeMs; open.endedByRefresh = true; }
      list.push({ startMs: timeMs, endMs: null, endedByRefresh: false });
    } else if (event.type === 'removebuff' || event.type === 'removedebuff') {
      if (open) open.endMs = timeMs;
    }
  }
  return spans;
}

/** Percentage of the fight the aura was up. Overlapping spans are merged, so multi-target debuffs read as "up somewhere", which is what a maintain rule means. */
export function auraUptimePct(windows: AuraWindows, spellId: number, fightDurationMs: number): number {
  if (fightDurationMs <= 0) return 0;
  const spans = (windows.get(spellId) ?? [])
    .map(([start, end]): [number, number] => [Math.max(0, start), Math.min(fightDurationMs, end ?? fightDurationMs)])
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] - b[0]);
  let covered = 0;
  let cursor = -1;
  for (const [start, end] of spans) {
    const from = Math.max(start, cursor);
    if (end > from) { covered += end - from; cursor = end; }
  }
  return (covered / fightDurationMs) * 100;
}
