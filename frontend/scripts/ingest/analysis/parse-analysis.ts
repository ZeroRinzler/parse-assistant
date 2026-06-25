/**
 * Transform layer - per-parse analysis orchestrator (pure).
 *
 * Turns an already-fetched ParseEventBundle into the cooldown_data + positions
 * payload by composing the focused helpers in this folder. Does no network or
 * file access; the rulebook-derived cooldown/defensive lists and the player's
 * combatant info are supplied by the caller.
 */

import { logWarn } from '../../../src/app/core/log.ts';
import { detectBloodlust, summarizeCooldownCasts, computeCastEfficiency } from './cooldowns.ts';
import { buildBuffWindows, summarizeDefensiveCasts } from './defensives.ts';
import { resolveTalentKey } from './gear.ts';
import { findBurstWindows } from './burst-windows.ts';
import { findDefensiveWindows } from './defensive-windows.ts';
import { buildParsePositions } from './positions.ts';
import type { RulebookCooldown, RulebookDefensive } from '../../../src/app/core/models/rulebook.models.ts';
import type { ParsePositions } from '../../../src/app/core/models/positioning.models.ts';
import type { ParseEventBundle, EnrichedRanking } from '../models/wcl.models.ts';
import type { ParseCooldownData } from '../models/parse-sample.models.ts';

const BURST_SIGNIFICANCE_PCT = 0.03;

export function analyzeParse(
  bundle: ParseEventBundle, spec: string,
  specCds: RulebookCooldown[], specDefensives: RulebookDefensive[],
  combatantInfo: EnrichedRanking['combatant_info'],
): { cooldown_data: ParseCooldownData; positions: ParsePositions | null } {
  const {
    player, npcById, abilityNames, start, fightDurS,
    castEvents, buffEvents, damageEvents, damageTakenEvents,
    enemyCastEvents, combatantEvents, bossDamageEvents,
  } = bundle;

  const blTimeS = detectBloodlust(buffEvents, start);
  const cdSummary = summarizeCooldownCasts(castEvents, specCds, start, blTimeS);
  const { castEffPct, castGapListMs } = computeCastEfficiency(castEvents, fightDurS);
  const burstWindows = findBurstWindows(damageEvents, start, cdSummary, specCds, BURST_SIGNIFICANCE_PCT, castEvents, abilityNames);
  const talentKey = resolveTalentKey(combatantEvents, player.id);

  const buffWindows = buildBuffWindows(buffEvents, start);
  const defensiveSummary = summarizeDefensiveCasts(specDefensives, buffWindows, castEvents, damageTakenEvents, start);
  const defensiveWindows = findDefensiveWindows(damageTakenEvents, start, buffWindows, specDefensives, npcById);

  const cooldownData: ParseCooldownData = {
    player: player.name,
    spec,
    fight_duration_s: Math.round(fightDurS * 10) / 10,
    bloodlust_s: blTimeS != null ? Math.round(blTimeS * 10) / 10 : null,
    cast_efficiency_pct: castEffPct,
    cast_gap_list_ms: castGapListMs,
    cooldowns: cdSummary,
    burst_windows: burstWindows,
    defensives: defensiveSummary,
    defensive_windows: defensiveWindows,
    talent_key: talentKey,
    trinkets: combatantInfo.trinkets,
    enchants: combatantInfo.enchants,
  };

  let positions: ParsePositions | null = null;
  try {
    positions = buildParsePositions(
      bundle.report_code, bundle.fight_id, player.name, player.id, npcById,
      [...castEvents, ...enemyCastEvents, ...bossDamageEvents], start, fightDurS,
    );
    if (!positions.player.length) positions = null;
  } catch (err) {
    logWarn(`buildParsePositions ${bundle.report_code}:${bundle.fight_id}`, err);
    positions = null;
  }

  return { cooldown_data: cooldownData, positions };
}
