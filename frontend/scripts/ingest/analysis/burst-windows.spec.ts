import { describe, it, expect } from 'vitest';
import { findBurstWindows, clusterBurstWindows } from './burst-windows.ts';
import { Events } from '../testing/events.ts';
import { FIGHT_START } from '../testing/clock.ts';
import { SHADOW_BLADES, EVISCERATE, BLACK_POWDER } from '../testing/spell-ids.ts';
import type { CdCastSummary, RawBurstWindow } from '../models/parse-sample.models.ts';
import type { RulebookCooldown } from '../../../src/app/core/models/rulebook.models.ts';

const SB: RulebookCooldown = { name: 'Shadow Blades', spell_id: SHADOW_BLADES, cooldown: 120, duration: 20 };

function cdSummary(castTimesS: number[]): CdCastSummary[] {
  return [{
    name: 'Shadow Blades', spell_id: SHADOW_BLADES, total_uses: castTimesS.length,
    first_cast_s: castTimesS[0] ?? null, bl_aligned: false, bl_offset_s: null,
    cast_times_s: castTimesS, hold_windows: [], cast_pattern: 'on_cooldown',
  }];
}

describe('findBurstWindows', () => {
  it('builds a window from a CD cast x duration and ranks abilities + counts casts', () => {
    const damage = Events.start()
      .damage(EVISCERATE, '0:11', 800)
      .damage(BLACK_POWDER, '0:12', 200)
      .damage(EVISCERATE, '0:50', 1000) // outside the [10,30]s window
      .build();
    const casts = Events.start()
      .cast(EVISCERATE, '0:11').cast(EVISCERATE, '0:15').cast(BLACK_POWDER, '0:12')
      .build();

    const windows = findBurstWindows(damage, FIGHT_START, cdSummary([10]), [SB], 0.03, casts);

    expect(windows).toHaveLength(1);
    const window = windows[0];
    expect(window.time_s).toBe(10);
    expect(window.window_length_s).toBe(20);
    expect(window.window_damage).toBe(1000);
    expect(window.total_damage).toBe(2000);
    expect(window.pct_of_total).toBe(0.5);
    expect(window.active_cds).toEqual(['Shadow Blades']);
    expect(window.ability_breakdown).toEqual([
      { spell_id: EVISCERATE, damage: 800, pct: 0.8, casts: 2 },
      { spell_id: BLACK_POWDER, damage: 200, pct: 0.2, casts: 1 },
    ]);
  });

  it('discards a window below the significance threshold', () => {
    const damage = Events.start()
      .damage(EVISCERATE, '0:11', 10)      // inside window: 10 / 10_010 ~ 0.001 < 0.03
      .damage(EVISCERATE, '1:00', 10_000)  // outside window
      .build();
    expect(findBurstWindows(damage, FIGHT_START, cdSummary([10]), [SB], 0.03)).toEqual([]);
  });

  it('merges windows within 3s into one', () => {
    // casts at 10s and 28s, each 20s long -> [10,30] and [28,48]; 28 <= 30+3 -> merge.
    const damage = Events.start().damage(EVISCERATE, '0:15', 500).damage(EVISCERATE, '0:40', 500).build();
    const windows = findBurstWindows(damage, FIGHT_START, cdSummary([10, 28]), [SB], 0.03);
    expect(windows).toHaveLength(1);
    expect(windows[0].time_s).toBe(10);
    expect(windows[0].window_length_s).toBe(38); // 48 - 10
  });

  it('returns [] when there is no damage, no casts, or no CD duration', () => {
    expect(findBurstWindows([], FIGHT_START, cdSummary([10]), [SB])).toEqual([]);
    const damage = Events.start().damage(EVISCERATE, '0:11', 500).build();
    expect(findBurstWindows(damage, FIGHT_START, cdSummary([]), [SB])).toEqual([]);
    const noDuration: RulebookCooldown = { name: 'Shadow Blades', spell_id: SHADOW_BLADES, cooldown: 120, duration: 0 };
    expect(findBurstWindows(damage, FIGHT_START, cdSummary([10]), [noDuration])).toEqual([]);
  });
});

describe('clusterBurstWindows', () => {
  function burst(timeS: number, cds: string[], length = 20, damage = 1000): RawBurstWindow {
    return {
      time_s: timeS, window_length_s: length, pct_of_total: 0.1, window_damage: damage, total_damage: 10_000,
      ability_breakdown: [{ spell_id: EVISCERATE, damage, pct: 1, casts: 1 }], active_cds: cds, target_count: 1,
    };
  }

  it('discards clusters smaller than max(2, 35% of samples)', () => {
    // 10 samples -> need >= 3.5 members; 3 is too few.
    const windows = [burst(10, ['A']), burst(11, ['A']), burst(12, ['A'])];
    expect(clusterBurstWindows(windows, 10)).toEqual([]);
  });

  it('keeps a large-enough cluster and surfaces only majority CDs', () => {
    const windows = [burst(10, ['A']), burst(11, ['A']), burst(12, ['A']), burst(13, ['B'])];
    const clustered = clusterBurstWindows(windows, 4); // need >= 2 members
    expect(clustered).toHaveLength(1);
    expect(clustered[0].common_cds).toEqual(['A']); // A in 3/4 (>=2); B in 1/4 (dropped)
    expect(clustered[0].count).toBe(4);
    expect(clustered[0].window_length_s).toBe(20); // mean of equal lengths
  });

  it('sorts multiple clusters by time', () => {
    const windows = [burst(60, ['A']), burst(61, ['A']), burst(10, ['A']), burst(11, ['A'])];
    const clustered = clusterBurstWindows(windows, 4);
    expect(clustered.map(c => c.time_s)).toEqual([10.5, 60.5]);
  });
});
