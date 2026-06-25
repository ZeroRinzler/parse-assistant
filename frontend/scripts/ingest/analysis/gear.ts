/**
 * Transform layer - gear and talent aggregation (pure).
 *
 * `resolveTalentKey` reads a parse's talent fingerprint from its CombatantInfo;
 * `aggregateGear` rolls talent builds, trinkets (slots 12/13), and enchants up
 * across all samples into the bench `gear` block.
 */

import { talentKeyFromTree } from '../../../src/app/core/services/wcl-mappers.ts';
import type { WclCombatantInfoEvent } from '../models/wcl.models.ts';
import type { ParseSample } from '../models/parse-sample.models.ts';
import type { GearStats } from '../models/bench.models.ts';

/** The full-tree talent key for the player's CombatantInfo (matches the frontend). */
export function resolveTalentKey(combatantEvents: WclCombatantInfoEvent[], playerId: number): string {
  const ciEvent = combatantEvents.find(event => event.sourceID === playerId) ?? combatantEvents[0];
  return talentKeyFromTree(ciEvent?.talentTree);
}

export function aggregateGear(samples: ParseSample[]): GearStats {
  const total = samples.length;
  const talentCounter = new Map<string, number>();
  const talentExample = new Map<string, { report_code: string; fight_id: number; player_name: string }>();
  const trinketCounters: Record<number, Map<number | string, number>> = { 12: new Map(), 13: new Map() };
  const trinketNames = new Map<number | string, string>();
  const enchantCounters = new Map<number, Map<number | string, number>>();
  const enchantNames = new Map<number | string, string>();

  for (const sample of samples) {
    const cdData = sample.cooldown_data;
    const talentKey = cdData.talent_key ?? '';
    if (talentKey) {
      talentCounter.set(talentKey, (talentCounter.get(talentKey) ?? 0) + 1);
      if (!talentExample.has(talentKey)) {
        talentExample.set(talentKey, {
          report_code: sample.report_code ?? '',
          fight_id: sample.fight_id,
          player_name: sample.player_name ?? '',
        });
      }
    }

    for (const trinket of (cdData.trinkets ?? [])) {
      const slot = trinket.slot as 12 | 13;
      const itemId = trinket.id;
      if ((slot === 12 || slot === 13) && itemId) {
        trinketCounters[slot].set(itemId, (trinketCounters[slot].get(itemId) ?? 0) + 1);
        if (!trinketNames.has(itemId)) trinketNames.set(itemId, trinket.name ?? '');
      }
    }

    for (const enchant of (cdData.enchants ?? [])) {
      const slot = enchant.slot;
      const enchantId = enchant.id;
      if (slot != null && enchantId) {
        if (!enchantCounters.has(slot)) enchantCounters.set(slot, new Map());
        const slotMap = enchantCounters.get(slot)!;
        slotMap.set(enchantId, (slotMap.get(enchantId) ?? 0) + 1);
        if (!enchantNames.has(enchantId)) enchantNames.set(enchantId, enchant.name ?? '');
      }
    }
  }

  const talentBuilds = [...talentCounter.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([key, count]) => ({
      key, count, pct: total ? Math.round(count / total * 100) : 0,
      ...(talentExample.get(key) ?? {}),
    }));

  const trinkets: GearStats['trinkets'] = {};
  for (const [slot, counter] of Object.entries(trinketCounters)) {
    const counterMap = counter as Map<number | string, number>;
    if (!counterMap.size) continue;
    trinkets[slot] = [...counterMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([id, count]) => ({ id, name: trinketNames.get(id) ?? '', count, pct: total ? Math.round(count / total * 100) : 0 }));
  }

  const enchants: GearStats['enchants'] = {};
  for (const [slot, counter] of enchantCounters.entries()) {
    if (!counter.size) continue;
    enchants[String(slot)] = [...counter.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([id, count]) => ({ id, name: enchantNames.get(id) ?? '', count, pct: total ? Math.round(count / total * 100) : 0 }));
  }

  return { sample_count: total, talent_builds: talentBuilds, trinkets, enchants };
}
