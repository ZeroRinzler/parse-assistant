/**
 * Transform layer - per-defensive cast analysis (pure).
 *
 * `buildBuffWindows` turns the buff stream into per-spell apply/remove windows;
 * `summarizeDefensiveCasts` derives each defensive's usage (buff-window-centric,
 * falling back to explicit casts for defensives without a self-buff), the damage
 * taken during each window, and hold windows.
 */

import type { RulebookDefensive } from '../../../src/app/core/models/rulebook.models.ts';
import type { WclResourceEvent } from '../models/wcl.models.ts';
import type { DefensiveCastSummary, HoldWindow } from '../models/parse-sample.models.ts';

// A gap beyond this past the expected on-cooldown time counts as a deliberate hold.
const HOLD_THRESHOLD_S = 8;
// Fallback window length (s) when a defensive has no rulebook duration.
const DEFAULT_WINDOW_S = 5;

/** Map<spell_id, [[start_s, end_s | null], ...]> from the buff apply/remove stream. */
export function buildBuffWindows(buffEvents: WclResourceEvent[], fightStartMs: number): Map<number, Array<[number, number | null]>> {
  const buffWindows = new Map<number, Array<[number, number | null]>>();
  for (const event of buffEvents) {
    const spellId = event.abilityGameID;
    if (spellId == null) continue;
    const timeS = (event.timestamp - fightStartMs) / 1000;
    if (event.type === 'applybuff') {
      if (!buffWindows.has(spellId)) buffWindows.set(spellId, []);
      buffWindows.get(spellId)!.push([timeS, null]);
    } else if (event.type === 'removebuff') {
      const windows = buffWindows.get(spellId) ?? [];
      for (let i = windows.length - 1; i >= 0; i--) {
        if (windows[i][1] == null) { windows[i][1] = timeS; break; }
      }
    }
  }
  return buffWindows;
}

export function summarizeDefensiveCasts(
  specDefensives: RulebookDefensive[],
  buffWindows: Map<number, Array<[number, number | null]>>,
  castEvents: WclResourceEvent[], damageTakenEvents: WclResourceEvent[],
  fightStartMs: number,
): DefensiveCastSummary[] {
  const defensiveSummary: DefensiveCastSummary[] = [];
  for (const defensive of specDefensives) {
    const spellId = defensive.spell_id;
    const duration = defensive.duration ?? 0;
    const cooldownS = defensive.cooldown ?? 90;
    const windows: Array<{ start_s: number; end_s: number; dmg_during: number }> = [];
    const castTimes: number[] = [];

    for (const buffWindow of (buffWindows.get(spellId) ?? [])) {
      const windowStart = buffWindow[0];
      const windowEnd = buffWindow[1] != null ? buffWindow[1] : (duration ? windowStart + duration : windowStart + DEFAULT_WINDOW_S);
      const dmgDuring = damageTakenEvents
        .filter(event => event.type === 'damage')
        .reduce((sum, event) => {
          const timeS = (event.timestamp - fightStartMs) / 1000;
          return timeS >= windowStart && timeS <= windowEnd ? sum + (event.amount ?? 0) + (event.absorbed ?? 0) : sum;
        }, 0);
      windows.push({ start_s: Math.round(windowStart * 10) / 10, end_s: Math.round(windowEnd * 10) / 10, dmg_during: Math.round(dmgDuring) });
      castTimes.push(Math.round(windowStart * 10) / 10);
    }

    // Defensives without a self-buff (no buff windows): fall back to explicit casts.
    if (castTimes.length === 0) {
      const casts = castEvents
        .filter(cast => cast.type === 'cast' && cast.abilityGameID === spellId)
        .map(cast => Math.round((cast.timestamp - fightStartMs) / 1000 * 10) / 10);
      for (const castTimeS of casts) {
        const windowEnd = castTimeS + (duration || DEFAULT_WINDOW_S);
        const dmgDuring = damageTakenEvents
          .filter(event => event.type === 'damage')
          .reduce((sum, event) => {
            const eventS = (event.timestamp - fightStartMs) / 1000;
            return eventS >= castTimeS && eventS <= windowEnd ? sum + (event.amount ?? 0) + (event.absorbed ?? 0) : sum;
          }, 0);
        windows.push({ start_s: castTimeS, end_s: Math.round(windowEnd * 10) / 10, dmg_during: Math.round(dmgDuring) });
        castTimes.push(castTimeS);
      }
    }

    castTimes.sort((a, b) => a - b);
    const holdWindows: HoldWindow[] = [];
    for (let castIndex = 1; castIndex < castTimes.length; castIndex++) {
      const expectedS = castTimes[castIndex - 1] + cooldownS;
      const actualS = castTimes[castIndex];
      const holdAmountS = actualS - expectedS;
      if (holdAmountS > HOLD_THRESHOLD_S) {
        holdWindows.push({
          cast_index: castIndex,
          expected_s: Math.round(expectedS * 10) / 10,
          actual_s: Math.round(actualS * 10) / 10,
          hold_amount_s: Math.round(holdAmountS * 10) / 10,
        });
      }
    }

    if (castTimes.length > 0) {
      defensiveSummary.push({
        name: defensive.name,
        spell_id: spellId,
        cooldown: cooldownS,
        uses: castTimes.length,
        cast_times_s: castTimes,
        first_cast_s: castTimes[0],
        hold_windows: holdWindows,
        cast_pattern: holdWindows.length > 0 ? 'hold' : 'on_cooldown',
        windows,
      });
    }
  }
  return defensiveSummary;
}
