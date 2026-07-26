import { WclEvent } from '../../core/models/wcl.models';
import { getOrInsert } from './analysis-math';

/** Map<spell_id, [[startMs, endMs | null], ...]> in fight-relative milliseconds. An open end means the aura outlived the fight. */
export type AuraWindows = Map<number, [number, number | null][]>;

/** Builds spans from an apply/remove stream; handles buffs and debuffs, so one call covers `Buffs` or `Debuffs` events. */
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

/** End-inclusive: a consuming cast shares the removal millisecond 38% of the time, so excluding it misreads correct play. */
export function isInsideAura(windows: AuraWindows, spellId: number, timeMs: number): boolean {
  return (windows.get(spellId) ?? []).some(([start, end]) => timeMs >= start && (end == null || timeMs <= end));
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
