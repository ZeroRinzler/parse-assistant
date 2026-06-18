/**
 * Shared formatting helpers and constants for the analysis modules.
 */

/** Bloodlust / Heroism / Time Warp / etc. - any of these starts a "BL window". */
export const BLOODLUST_IDS = new Set([2825, 32182, 80353, 90355, 264667, 390386]);

/** Bloodlust lasts 40s; the BL window adds grace on either side (see cooldown-analysis). */
export const BLOODLUST_DURATION_S = 40;

/** Format seconds as `m:ss` (zero-padded). */
export function fmtClock(s: number): string {
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}
