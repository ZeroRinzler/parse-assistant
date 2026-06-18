/**
 * Aggregates damage taken by ability: the top 10 sources and their share of
 * the player's total damage taken.
 */
import { DmgTakenAbility } from '../models/analysis.models';
import { WclEvent } from '../models/wcl.models';

export function analyzeDamageTaken(
  dtEvents: WclEvent[],
  abilityMap: Record<string, { name: string }>,
): { top: DmgTakenAbility[]; total: number } {
  const byAb: Record<number, number> = {};
  let total = 0;
  for (const e of dtEvents) {
    const amt = (e.amount || 0) + (e.absorbed || 0);
    if (!amt) continue;
    total += amt;
    if (e.abilityGameID) byAb[e.abilityGameID] = (byAb[e.abilityGameID] || 0) + amt;
  }
  const top = Object.entries(byAb)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([sid, dmg]) => ({
      spell_id: parseInt(sid, 10),
      name: abilityMap[sid]?.name || '',
      damage: Math.round(dmg),
      pct: total ? Math.round((dmg / total) * 1000) / 1000 : 0,
    }));
  return { top, total: Math.round(total) };
}
