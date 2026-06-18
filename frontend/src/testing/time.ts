/**
 * Time helpers for the fluent event builders.
 *
 * The analysis engine works entirely in "fight-relative" terms - every helper
 * computes `timestamp - fStart`. Tests default `fStart` to {@link FIGHT_START}
 * (0), so a builder timestamp lands at exactly the same fight-relative
 * millisecond the analysis sees. That lets a test say `"0:15"` and reason about
 * 15 seconds into the pull without juggling absolute server timestamps.
 */

/** Fight start used by the builders. Keeping it 0 makes builder ms == fight-relative ms. */
export const FIGHT_START = 0;

/**
 * Parse a clock string into milliseconds.
 *
 * Accepts `"m:ss"` / `"mm:ss"` (optionally with a fractional second, e.g.
 * `"1:30.5"`) or a bare number, which is treated as seconds. The seconds field
 * is validated to `00-59`.
 */
export function parseClock(t: string | number): number {
  if (typeof t === 'number') return Math.round(t * 1000);
  const m = /^(\d+):([0-5]?\d)(?:\.(\d+))?$/.exec(t.trim());
  if (!m) throw new Error(`Bad time string: "${t}" (expected "m:ss")`);
  const mins = Number(m[1]);
  const secs = Number(m[2]);
  const frac = m[3] ? Number(`0.${m[3]}`) : 0;
  return Math.round((mins * 60 + secs + frac) * 1000);
}
