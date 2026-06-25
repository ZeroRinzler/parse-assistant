import { describe, it, expect } from 'vitest';
import { detectBloodlust, summarizeCooldownCasts, computeCastEfficiency } from './cooldowns.ts';
import { Events } from '../testing/events.ts';
import { FIGHT_START } from '../testing/clock.ts';
import { SHADOW_BLADES, EVISCERATE } from '../testing/spell-ids.ts';
import { BLOODLUST_IDS } from '../../../src/app/core/analysis/format.ts';
import type { RulebookCooldown } from '../../../src/app/core/models/rulebook.models.ts';

const SB: RulebookCooldown = { name: 'Shadow Blades', spell_id: SHADOW_BLADES, cooldown: 120, duration: 20 };
const BLOODLUST = [...BLOODLUST_IDS][0];

describe('detectBloodlust', () => {
  it('returns fight-relative seconds of the first Bloodlust applybuff', () => {
    const buffs = Events.start().applyBuff(BLOODLUST, '0:15').build();
    expect(detectBloodlust(buffs, FIGHT_START)).toBe(15);
  });

  it('returns null when no Bloodlust buff is present', () => {
    const buffs = Events.start().applyBuff(SHADOW_BLADES, '0:05').build();
    expect(detectBloodlust(buffs, FIGHT_START)).toBeNull();
  });
});

describe('summarizeCooldownCasts', () => {
  it('records first cast and BL alignment + offset when cast inside the BL window', () => {
    const casts = Events.cast(SHADOW_BLADES, '0:20').build();
    const [summary] = summarizeCooldownCasts(casts, [SB], FIGHT_START, 15);
    expect(summary.total_uses).toBe(1);
    expect(summary.first_cast_s).toBe(20);
    expect(summary.bl_aligned).toBe(true);
    expect(summary.bl_offset_s).toBe(5); // 20 - 15
    expect(summary.cast_pattern).toBe('on_cooldown');
  });

  it('is not BL-aligned when the only cast falls outside the window', () => {
    const casts = Events.cast(SHADOW_BLADES, '2:00').build();
    const [summary] = summarizeCooldownCasts(casts, [SB], FIGHT_START, 15);
    expect(summary.bl_aligned).toBe(false);
    expect(summary.bl_offset_s).toBeNull();
  });

  it('flags a hold window when a recast is >8s past on-cooldown time', () => {
    const casts = Events.cast(SHADOW_BLADES, '0:05').cast(SHADOW_BLADES, '2:20').build(); // 5s then 140s
    const [summary] = summarizeCooldownCasts(casts, [SB], FIGHT_START, null);
    expect(summary.cast_pattern).toBe('hold');
    expect(summary.hold_windows).toEqual([
      { cast_index: 2, expected_s: 125, actual_s: 140, hold_amount_s: 15 }, // 5+120=125, held 15s
    ]);
  });
});

describe('computeCastEfficiency', () => {
  it('returns null efficiency and an empty gap list for fewer than 2 casts', () => {
    const oneCast = Events.cast(EVISCERATE, '0:05').build();
    expect(computeCastEfficiency(oneCast, 60)).toEqual({ castEffPct: null, castGapListMs: [] });
  });

  it('counts only gaps over 1.5s as downtime and reports the sorted gap list', () => {
    const casts = Events.cast(EVISCERATE, '0:00').cast(EVISCERATE, '0:01').cast(EVISCERATE, '0:05').build();
    const { castEffPct, castGapListMs } = computeCastEfficiency(casts, 10);
    expect(castGapListMs).toEqual([1000, 4000]); // sorted ascending
    // only the 4000ms gap is downtime -> (1 - 4/10) * 100 = 60
    expect(castEffPct).toBe(60);
  });
});
