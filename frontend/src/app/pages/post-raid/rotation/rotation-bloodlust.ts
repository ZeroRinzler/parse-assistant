import { TimedEvent } from '../../../shared/analysis/wcl-projections';
import { buildAuraWindows } from '../../../shared/analysis/aura-windows';

/** Bloodlust / Heroism / Time Warp and equivalents. */
const BLOODLUST_IDS = new Set([2825, 32182, 80353, 90355, 264667, 390386]);

// Returns whatever start buildAuraWindows finds, negative included: a Lust cast before the pull still covers the opener.
export function detectBloodlust(buffEvents: TimedEvent[]): number | null {
  const windows = buildAuraWindows(buffEvents);
  const starts = [...BLOODLUST_IDS]
    .map(id => windows.get(id)?.[0]?.[0])
    .filter((start): start is number => start != null);
  return starts.length ? Math.min(...starts) : null;
}
