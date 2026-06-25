import { describe, it, expect } from 'vitest';
import { analyzeParse } from './parse-analysis.ts';
import { Events, PLAYER, BOSS } from '../testing/events.ts';
import { SHADOW_BLADES, EVISCERATE } from '../testing/spell-ids.ts';
import { BLOODLUST_IDS } from '../../../src/app/core/analysis/format.ts';
import type { ParseEventBundle, WclActorEntry, EnrichedRanking } from '../models/wcl.models.ts';
import type { RulebookCooldown } from '../../../src/app/core/models/rulebook.models.ts';

const BLOODLUST = [...BLOODLUST_IDS][0];
const SB: RulebookCooldown = { name: 'Shadow Blades', spell_id: SHADOW_BLADES, cooldown: 120, duration: 20 };
const combatantInfo: EnrichedRanking['combatant_info'] = {
  talent_key: '', trinkets: [{ slot: 12, id: 100, name: 'T' }], enchants: [],
};

function bundle(over: Partial<ParseEventBundle> = {}): ParseEventBundle {
  const player: WclActorEntry = { id: PLAYER, name: 'Tester', type: 'Player' };
  return {
    report_code: 'rep', fight_id: 1, player,
    npcById: new Map<number, WclActorEntry>([[BOSS, { id: BOSS, name: 'Boss', type: 'NPC', gameID: 5000 }]]),
    abilityNames: new Map<number, string>(),
    start: 0, end: 60_000, fightDurS: 60,
    castEvents: [], buffEvents: [], damageEvents: [], damageTakenEvents: [],
    enemyCastEvents: [], combatantEvents: [], bossDamageEvents: [],
    ...over,
  };
}

describe('analyzeParse', () => {
  it('assembles cooldown_data from the event bundle and carries gear from combatant info', () => {
    const input = bundle({
      castEvents: Events.cast(SHADOW_BLADES, '0:05').build(),
      buffEvents: Events.start().applyBuff(BLOODLUST, '0:10').build(),
      damageEvents: Events.start().damage(EVISCERATE, '0:06', 1000).build(),
    });

    const { cooldown_data, positions } = analyzeParse(input, 'SubtletyRogue', [SB], [], combatantInfo);

    expect(cooldown_data.player).toBe('Tester');
    expect(cooldown_data.spec).toBe('SubtletyRogue');
    expect(cooldown_data.fight_duration_s).toBe(60);
    expect(cooldown_data.bloodlust_s).toBe(10);
    expect(cooldown_data.cooldowns).toHaveLength(1);
    expect(cooldown_data.cooldowns[0]).toMatchObject({ name: 'Shadow Blades', total_uses: 1, first_cast_s: 5, bl_aligned: true });
    expect(cooldown_data.burst_windows).toHaveLength(1);
    expect(cooldown_data.trinkets).toEqual([{ slot: 12, id: 100, name: 'T' }]);
    // No position-bearing events -> no player timeline -> positions null.
    expect(positions).toBeNull();
  });

  it('produces positions when the bundle carries coordinates', () => {
    const positionedCasts = Events.start()
      .position(PLAYER, 0, 0, 0).position(PLAYER, 1.5, 10, 0).position(PLAYER, 3, 20, 0)
      .build();
    const input = bundle({ castEvents: positionedCasts, fightDurS: 3 });

    const { positions } = analyzeParse(input, 'SubtletyRogue', [SB], [], combatantInfo);
    expect(positions).not.toBeNull();
    expect(positions!.player.length).toBeGreaterThan(0);
  });
});
