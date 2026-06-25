import { describe, it, expect } from 'vitest';
import { findDefensiveWindows, clusterDefensiveWindows } from './defensive-windows.ts';
import { Events, BOSS } from '../testing/events.ts';
import { FIGHT_START } from '../testing/clock.ts';
import { CLOAK_OF_SHADOWS, FEINT, BOSS_SWING } from '../testing/spell-ids.ts';
import type { WclActorEntry } from '../models/wcl.models.ts';
import type { RawDefensiveWindow } from '../models/parse-sample.models.ts';
import type { RulebookDefensive } from '../../../src/app/core/models/rulebook.models.ts';

const CLOAK: RulebookDefensive = { name: 'Cloak of Shadows', spell_id: CLOAK_OF_SHADOWS, cooldown: 120, duration: 5 };
const npcById = new Map<number, WclActorEntry>([[BOSS, { id: BOSS, name: 'Boss', type: 'NPC', gameID: 5000 }]]);

describe('findDefensiveWindows', () => {
  it('slices damage taken by the buff window and attributes the dominant enemy', () => {
    const buffWindows = new Map<number, Array<[number, number | null]>>([[CLOAK_OF_SHADOWS, [[10, 15]]]]);
    const damageTaken = Events.start()
      .damageTaken(BOSS_SWING, '0:12', 1000, { source: BOSS }) // inside [10,15]
      .damageTaken(BOSS_SWING, '0:30', 1000, { source: BOSS }) // outside
      .build();

    const windows = findDefensiveWindows(damageTaken, FIGHT_START, buffWindows, [CLOAK], npcById);

    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({
      time_s: 10,
      window_length_s: 5,
      window_damage: 1000,
      total_damage: 2000,
      pct_of_total: 0.5,
      defensive_name: 'Cloak of Shadows',
      spell_id: CLOAK_OF_SHADOWS,
      ref_game_id: 5000,
    });
    expect(windows[0].ability_breakdown).toEqual([{ spell_id: BOSS_SWING, damage: 1000, pct: 1 }]);
  });

  it('uses the rulebook duration when the buff window has no remove (end null)', () => {
    const buffWindows = new Map<number, Array<[number, number | null]>>([[CLOAK_OF_SHADOWS, [[20, null]]]]);
    const damageTaken = Events.start().damageTaken(BOSS_SWING, '0:22', 500, { source: BOSS }).build();
    const windows = findDefensiveWindows(damageTaken, FIGHT_START, buffWindows, [CLOAK], npcById);
    expect(windows[0].window_length_s).toBe(5); // 25 - 20 from duration
  });

  it('returns [] when no damage was taken', () => {
    const buffWindows = new Map<number, Array<[number, number | null]>>([[CLOAK_OF_SHADOWS, [[10, 15]]]]);
    expect(findDefensiveWindows([], FIGHT_START, buffWindows, [CLOAK], npcById)).toEqual([]);
  });
});

describe('clusterDefensiveWindows', () => {
  function defWindow(name: string, spellId: number, timeS: number): RawDefensiveWindow {
    return {
      time_s: timeS, window_length_s: 5, pct_of_total: 0.2, window_damage: 1000, total_damage: 5000,
      ability_breakdown: [{ spell_id: BOSS_SWING, damage: 1000, pct: 1 }],
      active_cds: [name], defensive_name: name, spell_id: spellId, ref_game_id: 5000,
    };
  }

  it('clusters per-defensive first so two defensives at the same time stay separate', () => {
    const windows = [
      defWindow('Cloak of Shadows', CLOAK_OF_SHADOWS, 10), defWindow('Cloak of Shadows', CLOAK_OF_SHADOWS, 11),
      defWindow('Feint', FEINT, 10), defWindow('Feint', FEINT, 11),
    ];
    const clustered = clusterDefensiveWindows(windows, 4); // need >= 2 members each
    expect(clustered).toHaveLength(2);
    expect(clustered.map(c => c.defensive_name).sort()).toEqual(['Cloak of Shadows', 'Feint']);
    for (const cluster of clustered) {
      expect(cluster.count).toBe(2);
      expect(cluster.window_length_s).toBe(5);
    }
  });

  it('discards clusters smaller than max(2, 35% of samples)', () => {
    const windows = [defWindow('Cloak of Shadows', CLOAK_OF_SHADOWS, 10), defWindow('Cloak of Shadows', CLOAK_OF_SHADOWS, 11)];
    expect(clusterDefensiveWindows(windows, 10)).toEqual([]); // need >= 3.5, only 2
  });
});
