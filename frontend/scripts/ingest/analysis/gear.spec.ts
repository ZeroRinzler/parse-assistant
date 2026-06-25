import { describe, it, expect } from 'vitest';
import { resolveTalentKey, aggregateGear } from './gear.ts';
import { talentKeyFromTree } from '../../../src/app/core/services/wcl-mappers.ts';
import { sample } from '../testing/samples.ts';
import type { WclCombatantInfoEvent } from '../models/wcl.models.ts';

describe('resolveTalentKey', () => {
  it('reads the talent tree from the player\'s CombatantInfo event', () => {
    const playerTree = [{ nodeID: 10, id: 1, rank: 1 }];
    const events: WclCombatantInfoEvent[] = [
      { type: 'combatantinfo', timestamp: 0, sourceID: 9, talentTree: [{ nodeID: 99 }] },
      { type: 'combatantinfo', timestamp: 0, sourceID: 1, talentTree: playerTree },
    ];
    expect(resolveTalentKey(events, 1)).toBe(talentKeyFromTree(playerTree));
  });

  it('falls back to the first event, then to an empty tree', () => {
    expect(resolveTalentKey([], 1)).toBe(talentKeyFromTree(undefined));
  });
});

describe('aggregateGear', () => {
  it('counts talent builds with pct and a worked example, most-common first', () => {
    const samples = [
      sample({ talent_key: 'A' }, { report_code: 'r1', fight_id: 1, player_name: 'Ann' }),
      sample({ talent_key: 'A' }),
      sample({ talent_key: 'B' }),
    ];
    const gear = aggregateGear(samples);
    expect(gear.sample_count).toBe(3);
    expect(gear.talent_builds[0]).toMatchObject({ key: 'A', count: 2, pct: 67, report_code: 'r1', player_name: 'Ann' });
    expect(gear.talent_builds[1]).toMatchObject({ key: 'B', count: 1, pct: 33 });
  });

  it('aggregates trinkets per slot (12/13) and enchants per slot, ranked by count', () => {
    const samples = [
      sample({ trinkets: [{ slot: 12, id: 100, name: 'Tier Trinket' }], enchants: [{ slot: 15, id: 200, name: 'Enchant A' }] }),
      sample({ trinkets: [{ slot: 12, id: 100, name: 'Tier Trinket' }], enchants: [{ slot: 15, id: 200, name: 'Enchant A' }] }),
      sample({ trinkets: [{ slot: 12, id: 101, name: 'Other' }], enchants: [{ slot: 15, id: 201, name: 'Enchant B' }] }),
    ];
    const gear = aggregateGear(samples);
    expect(gear.trinkets['12']).toEqual([
      { id: 100, name: 'Tier Trinket', count: 2, pct: 67 },
      { id: 101, name: 'Other', count: 1, pct: 33 },
    ]);
    expect(gear.enchants['15']).toEqual([
      { id: 200, name: 'Enchant A', count: 2, pct: 67 },
      { id: 201, name: 'Enchant B', count: 1, pct: 33 },
    ]);
  });
});
