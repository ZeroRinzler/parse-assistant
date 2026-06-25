/** Fight-relative time helpers for ingest tests. */

/** Fight start, in ms. Tests express event times relative to this (so 0). */
export const FIGHT_START = 0;

/**
 * Parse a "m:ss" clock string (or a number of seconds) into milliseconds, the
 * unit WCL event timestamps use. `parseClock('1:30') === 90_000`,
 * `parseClock(90) === 90_000`.
 */
export function parseClock(time: string | number): number {
  if (typeof time === 'number') return Math.round(time * 1000);
  const [minutes, seconds] = time.split(':').map(Number);
  return Math.round((minutes * 60 + seconds) * 1000);
}
