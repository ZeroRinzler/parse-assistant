import { describe, it, expect } from 'vitest';
import { buildBuffWindows, summarizeDefensiveCasts } from './defensives.ts';
import { Events, BOSS } from '../testing/events.ts';
import { FIGHT_START } from '../testing/clock.ts';
import { CLOAK_OF_SHADOWS, FEINT, BOSS_SWING } from '../testing/spell-ids.ts';
import type { RulebookDefensive } from '../../../src/app/core/models/rulebook.models.ts';

const CLOAK: RulebookDefensive = { name: 'Cloak of Shadows', spell_id: CLOAK_OF_SHADOWS, cooldown: 120, duration: 5 };
const FEINT_DEF: RulebookDefensive = { name: 'Feint', spell_id: FEINT, cooldown: 30, duration: 6 };

describe('buildBuffWindows', () => {
  it('pairs applybuff/removebuff into [start, end] windows per spell', () => {
    const buffs = Events.start().buffWindow(CLOAK_OF_SHADOWS, '0:10', '0:15').build();
    const windows = buildBuffWindows(buffs, FIGHT_START);
    expect(windows.get(CLOAK_OF_SHADOWS)).toEqual([[10, 15]]);
  });

  it('leaves an unclosed window end as null', () => {
    const buffs = Events.start().applyBuff(CLOAK_OF_SHADOWS, '0:10').build();
    expect(buildBuffWindows(buffs, FIGHT_START).get(CLOAK_OF_SHADOWS)).toEqual([[10, null]]);
  });
});

describe('summarizeDefensiveCasts', () => {
  it('derives windows from buffs and sums damage taken during each', () => {
    const buffWindows = buildBuffWindows(Events.start().buffWindow(CLOAK_OF_SHADOWS, '0:10', '0:15').build(), FIGHT_START);
    const damageTaken = Events.start()
      .damageTaken(BOSS_SWING, '0:12', 500, { source: BOSS })
      .damageTaken(BOSS_SWING, '0:20', 100, { source: BOSS }) // outside window
      .build();

    const [summary] = summarizeDefensiveCasts([CLOAK], buffWindows, [], damageTaken, FIGHT_START);
    expect(summary.uses).toBe(1);
    expect(summary.first_cast_s).toBe(10);
    expect(summary.cast_pattern).toBe('on_cooldown');
    expect(summary.windows).toEqual([{ start_s: 10, end_s: 15, dmg_during: 500 }]);
  });

  it('falls back to explicit casts when a defensive has no buff windows, and flags holds', () => {
    const casts = Events.cast(FEINT, '0:05').cast(FEINT, '0:50').build();
    const [summary] = summarizeDefensiveCasts([FEINT_DEF], new Map(), casts, [], FIGHT_START);

    expect(summary.uses).toBe(2);
    expect(summary.cast_times_s).toEqual([5, 50]);
    expect(summary.cast_pattern).toBe('hold');
    // expected 5 + 30 = 35, actual 50 -> held 15s
    expect(summary.hold_windows).toEqual([{ cast_index: 1, expected_s: 35, actual_s: 50, hold_amount_s: 15 }]);
  });

  it('omits a defensive that was never used', () => {
    expect(summarizeDefensiveCasts([CLOAK], new Map(), [], [], FIGHT_START)).toEqual([]);
  });
});
