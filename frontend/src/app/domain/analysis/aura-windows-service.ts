import { inject, Injectable } from '@angular/core';
import { getOrInsert } from './analysis-math';
import { TimedEvent } from './wcl-projections-service';
import { WclProjectionsService } from './wcl-projections-service';

@Injectable({ providedIn: 'root' })
export class AuraWindowsService {
  private readonly projections = inject(WclProjectionsService);

  private spanEdgeOf(type: string): AuraSpanEdge | null {
    if (type === 'applybuff' || type === 'applydebuff') return 'open';
    if (type === 'refreshbuff' || type === 'refreshdebuff') return 'refresh';
    if (type === 'removebuff' || type === 'removedebuff') return 'close';
    return null;
  }

  private lastOpen(spans: [number, number | null][]): [number, number | null] | undefined {
    return [...spans].reverse().find(span => span[1] == null);
  }

  private applyWindowEdge(spans: [number, number | null][], edge: AuraSpanEdge, timeS: number): void {
    if (edge === 'open') { spans.push([timeS, null]); return; }
    const open = this.lastOpen(spans);
    if (open && edge === 'close') open[1] = timeS;
    // WCL emits no synthetic apply for an aura already up at the pull, so a bare remove or refresh is the only trace it leaves.
    else if (!open) spans.push([0, edge === 'close' ? timeS : null]);
  }

  /** Buffs and debuffs carry the same apply/remove shape, so one call covers either stream. */
  buildAuraWindows(events: TimedEvent[]): AuraWindows {
    const windows: AuraWindows = new Map();
    for (const event of events) {
      const spellId = event.abilityGameID;
      const edge = this.spanEdgeOf(event.type);
      if (!spellId || !edge) continue;
      this.applyWindowEdge(getOrInsert(windows, spellId, () => []), edge, event.atS);
    }
    return windows;
  }

  /** Up at that instant, both edges counted: a consuming cast shares the removal second 38% of the time. */
  auraUpAt(windows: AuraWindows, spellId: number, timeS: number): boolean {
    return (windows.get(spellId) ?? []).some(([start, end]) => timeS >= start && (end == null || timeS <= end));
  }

  /** Up going INTO that instant: the cast that grants a state shares its applybuff timestamp, which `auraUpAt` would credit it with. */
  auraAlreadyUpAt(windows: AuraWindows, spellId: number, timeS: number): boolean {
    return (windows.get(spellId) ?? []).some(([start, end]) => timeS > start && (end == null || timeS <= end));
  }

  /** A bare apply carries no count and means one; every stack event carries the new total, clamped so a reported drop below zero cannot leak through. */
  private stackEdgeOf(event: TimedEvent): { count: number; opens: boolean } | null {
    const type = event.type;
    if (type === 'applybuff' || type === 'applydebuff') return { count: Math.max(0, event.stack ?? 1), opens: true };
    if (type.endsWith('buffstack') || type.endsWith('debuffstack')) return { count: Math.max(0, event.stack ?? 0), opens: false };
    if (type === 'removebuff' || type === 'removedebuff') return { count: 0, opens: false };
    return null;
  }

  buildStackTimeline(events: TimedEvent[], spellId: number): StackTimeline {
    const entries: [number, number][] = [];
    let groundedFromStart = false;
    for (const event of events) {
      if (event.abilityGameID !== spellId) continue;
      const edge = this.stackEdgeOf(event);
      if (!edge) continue;
      if (!entries.length && edge.opens) groundedFromStart = true;
      entries.push([event.atS, edge.count]);
    }
    return { groundedFromStart, entries };
  }

  /** The count in force going INTO that moment, or null when `groundedFromStart` is false and nothing earlier is known; WCL logs a consuming cast and the stack it spends on one timestamp, so a same-instant change belongs to the cast rather than preceding it. */
  stacksAt(timeline: StackTimeline, timeS: number): number | null {
    let count: number | null = timeline.groundedFromStart ? 0 : null;
    for (const [at, value] of timeline.entries) {
      if (at >= timeS) break;
      count = value;
    }
    return count;
  }

  private applySpanEdge(list: AuraSpan[], edge: AuraSpanEdge | null, timeS: number): void {
    const tail = list[list.length - 1];
    const open = tail && tail.endS == null ? tail : null;
    if (edge === 'open') {
      if (!open) list.push({ startS: timeS, endS: null, endedByRefresh: false });
    } else if (edge === 'refresh') {
      if (open) { open.endS = timeS; open.endedByRefresh = true; }
      list.push({ startS: timeS, endS: null, endedByRefresh: false });
    } else if (edge === 'close' && open) {
      open.endS = timeS;
    }
  }

  buildAuraSpansByTarget(events: TimedEvent[], spellId: number): AuraSpansByTarget {
    const spans: AuraSpansByTarget = new Map();
    for (const event of events) {
      if (event.abilityGameID !== spellId) continue;
      const list = getOrInsert(spans, this.projections.targetKey(event), (): AuraSpan[] => []);
      this.applySpanEdge(list, this.spanEdgeOf(event.type), event.atS);
    }
    return spans;
  }

  /** Percentage of the fight the aura was up. Overlapping spans are merged, so multi-target debuffs read as "up somewhere", which is what a maintain rule means. */
  auraUptimePct(windows: AuraWindows, spellId: number, fightDurationS: number): number {
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
}

/** Fight-relative seconds; an open end means the aura outlived the fight. */
export type AuraWindows = Map<number, [number, number | null][]>;

type AuraSpanEdge = 'open' | 'refresh' | 'close';

/** groundedFromStart is false when the first entry is a bare remove or stack event rather than an apply, meaning nothing before it is known. */
export interface StackTimeline {
  readonly groundedFromStart: boolean;
  readonly entries: readonly [number, number][];
}

/** One unbroken application on one target. `endedByRefresh` separates a re-application from an expiry, which read the same in the stream. */
export interface AuraSpan {
  startS: number;
  endS: number | null;
  endedByRefresh: boolean;
}

/** One aura's spans per target, since a clip is only visible against the application it replaced. */
export type AuraSpansByTarget = Map<string, AuraSpan[]>;
