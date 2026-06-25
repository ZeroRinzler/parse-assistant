/**
 * Transform layer - per-cooldown cast analysis (pure).
 *
 * Helpers carved out of the per-parse pipeline: Bloodlust detection, the per-CD
 * cast summary (first cast, BL alignment, hold windows), and cast efficiency.
 */

import { BLOODLUST_IDS } from '../../../src/app/core/analysis/format.ts';
import type { RulebookCooldown } from '../../../src/app/core/models/rulebook.models.ts';
import type { WclResourceEvent } from '../models/wcl.models.ts';
import type { CdCastSummary, HoldWindow } from '../models/parse-sample.models.ts';

// BL window: a CD counts as aligned if cast from 30s before to 55s after BL start.
const BL_WINDOW_BEFORE_S = 30;
const BL_WINDOW_AFTER_S = 55;
// A gap beyond this past the expected on-cooldown time counts as a deliberate hold.
const HOLD_THRESHOLD_S = 8.0;
// Casts separated by more than this (ms) count as downtime in cast efficiency.
const DOWNTIME_GAP_MS = 1500;

/** Fight-relative seconds of the first Bloodlust/Heroism/etc., or null if none. */
export function detectBloodlust(buffEvents: WclResourceEvent[], fightStartMs: number): number | null {
  for (const event of buffEvents) {
    if (event.type === 'applybuff' && event.abilityGameID != null && BLOODLUST_IDS.has(event.abilityGameID)) {
      return (event.timestamp - fightStartMs) / 1000;
    }
  }
  return null;
}

/** Per-CD cast summary: usage count, first cast, BL alignment, and hold windows. */
export function summarizeCooldownCasts(
  castEvents: WclResourceEvent[], specCds: RulebookCooldown[],
  fightStartMs: number, blTimeS: number | null,
): CdCastSummary[] {
  const cdSummary: CdCastSummary[] = [];
  for (const cooldown of specCds) {
    const cdCasts = castEvents
      .filter(cast => cast.type === 'cast' && cast.abilityGameID === cooldown.spell_id)
      .sort((a, b) => a.timestamp - b.timestamp);

    const castTimesS = cdCasts.map(cast => (cast.timestamp - fightStartMs) / 1000);
    const firstCastS = castTimesS.length > 0 ? castTimesS[0] : null;

    let blAligned = false;
    let blOffsetS: number | null = null;
    if (blTimeS != null && castTimesS.length > 0) {
      for (const timeS of castTimesS) {
        if (blTimeS - BL_WINDOW_BEFORE_S <= timeS && timeS <= blTimeS + BL_WINDOW_AFTER_S) { blAligned = true; break; }
      }
      const windowOffsets = castTimesS
        .filter(timeS => blTimeS! - BL_WINDOW_BEFORE_S <= timeS && timeS <= blTimeS! + BL_WINDOW_AFTER_S)
        .map(timeS => timeS - blTimeS!);
      if (windowOffsets.length > 0) {
        blOffsetS = Math.round(windowOffsets.reduce((best, offset) => Math.abs(offset) < Math.abs(best) ? offset : best) * 10) / 10;
      }
    }

    const holdWindows: HoldWindow[] = [];
    if (castTimesS.length > 1) {
      const cdSeconds = cooldown.cooldown ?? 90;
      let expectedT = castTimesS[0];
      for (let castIndex = 1; castIndex < castTimesS.length; castIndex++) {
        expectedT += cdSeconds;
        const actual = castTimesS[castIndex];
        const holdAmount = actual - expectedT;
        if (holdAmount > HOLD_THRESHOLD_S) {
          holdWindows.push({
            cast_index: castIndex + 1,
            expected_s: Math.round(expectedT * 10) / 10,
            actual_s: Math.round(actual * 10) / 10,
            hold_amount_s: Math.round(holdAmount * 10) / 10,
          });
        }
      }
    }

    cdSummary.push({
      name: cooldown.name,
      spell_id: cooldown.spell_id,
      total_uses: cdCasts.length,
      first_cast_s: firstCastS != null ? Math.round(firstCastS * 10) / 10 : null,
      bl_aligned: blAligned,
      bl_offset_s: blOffsetS,
      cast_times_s: castTimesS.map(timeS => Math.round(timeS * 100) / 100),
      hold_windows: holdWindows,
      cast_pattern: holdWindows.length > 0 ? 'hold' : 'on_cooldown',
    });
  }
  return cdSummary;
}

/**
 * Active-casting efficiency: the share of fight time not spent in cast gaps longer
 * than DOWNTIME_GAP_MS. Returns null efficiency (and an empty gap list) when there
 * are fewer than 2 casts. The gap list is sorted ascending for later p90 use.
 */
export function computeCastEfficiency(
  castEvents: WclResourceEvent[], fightDurS: number,
): { castEffPct: number | null; castGapListMs: number[] } {
  const completed = castEvents.filter(event => event.type === 'cast').sort((a, b) => a.timestamp - b.timestamp);
  if (completed.length < 2 || fightDurS <= 0) return { castEffPct: null, castGapListMs: [] };

  const castGapListMs: number[] = [];
  for (let i = 1; i < completed.length; i++) {
    castGapListMs.push(Math.round(completed[i].timestamp - completed[i - 1].timestamp));
  }
  castGapListMs.sort((a, b) => a - b);
  const downtimeMs = castGapListMs.filter(gap => gap > DOWNTIME_GAP_MS).reduce((sum, gap) => sum + gap, 0);
  const castEffPct = Math.round(Math.max(0, (1 - downtimeMs / 1000 / fightDurS) * 100) * 10) / 10;
  return { castEffPct, castGapListMs };
}
