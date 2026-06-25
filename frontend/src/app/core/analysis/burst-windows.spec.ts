import { describe, it, expect } from 'vitest';
import { findPlayerBurstWindows, computePlayerDefensiveWindows } from './burst-windows';
import { BurstWindow } from '../models/analysis.models';
import { Events } from '../../../testing/builders/events';
import { FIGHT_START } from '../../../testing/time';
import { EVISCERATE, BLACK_POWDER, SHADOW_BLADES, SHADOW_BLADES_DAMAGE } from '../../../testing/spell-ids';

const window: BurstWindow = { time_s: 10, window_length_s: 20, dmg_avg: 0, dmg_min: 0, dmg_max: 0, dmg_stddev: 0, ability_breakdown: [] }; // covers [10, 30)
const NO_NAMES = new Map<number, string>();

describe('findPlayerBurstWindows', () => {
  it('sums amount + absorbed for events inside the half-open window', () => {
    const dmg = Events.start()
      .damage(EVISCERATE, '0:15', 1000, { absorbed: 200 }) // inside
      .damage(EVISCERATE, '0:25', 500) // inside
      .build();

    const [pw] = findPlayerBurstWindows([window], dmg, [], FIGHT_START, NO_NAMES);

    expect(pw.window_damage).toBe(1700);
  });

  it('excludes an event at exactly time_s + window_length_s (window is half-open)', () => {
    const dmg = Events.start().damage(EVISCERATE, '0:30', 9999).build(); // 30s == window end

    const [pw] = findPlayerBurstWindows([window], dmg, [], FIGHT_START, NO_NAMES);

    expect(pw.window_damage).toBe(0);
  });

  it('breaks damage down per ability, largest first', () => {
    const dmg = Events.start()
      .damage(EVISCERATE, '0:12', 300)
      .damage(BLACK_POWDER, '0:14', 800)
      .damage(EVISCERATE, '0:16', 200)
      .build();

    const [pw] = findPlayerBurstWindows([window], dmg, [], FIGHT_START, NO_NAMES);

    expect(pw.ability_breakdown).toEqual([
      { spell_id: BLACK_POWDER, damage: 800 },
      { spell_id: EVISCERATE, damage: 500 },
    ]);
  });

  it('attributes casts to the damage row by ability NAME when cast and damage ids differ', () => {
    // Shadow Blades is cast as 121471 but its damage rows are 279043. Without the
    // name bridge the damage row would show 0 casts.
    const names = new Map<number, string>([
      [SHADOW_BLADES, 'Shadow Blades'],
      [SHADOW_BLADES_DAMAGE, 'Shadow Blades'],
      [EVISCERATE, 'Eviscerate'],
    ]);
    const dmg = Events.start()
      .damage(SHADOW_BLADES_DAMAGE, '0:12', 900)
      .damage(EVISCERATE, '0:16', 500)
      .build();
    const casts = Events.start()
      .cast(SHADOW_BLADES, '0:11')
      .cast(EVISCERATE, '0:15')
      .cast(EVISCERATE, '0:18')
      .build();

    const [pw] = findPlayerBurstWindows([window], dmg, casts, FIGHT_START, names);

    expect(pw.ability_breakdown).toEqual([
      { spell_id: SHADOW_BLADES_DAMAGE, damage: 900, casts: 1 },
      { spell_id: EVISCERATE, damage: 500, casts: 2 },
    ]);
  });
});

describe('findPlayerBurstWindows / empty windows', () => {
  it('returns an empty array when the windows input is empty', () => {
    const dmg = Events.start().damage(EVISCERATE, '0:15', 1000).build();
    expect(findPlayerBurstWindows([], dmg, [], FIGHT_START, NO_NAMES)).toHaveLength(0);
  });

  it('returns window_damage of 0 when all events fall outside the window', () => {
    const dmg = Events.start()
      .damage(EVISCERATE, '0:05', 999) // before window start (10s)
      .damage(EVISCERATE, '0:30', 999) // exactly at window end (excluded, half-open)
      .build();
    const [pw] = findPlayerBurstWindows([window], dmg, [], FIGHT_START, NO_NAMES);
    expect(pw.window_damage).toBe(0);
  });
});

describe('computePlayerDefensiveWindows', () => {
  it('sums damage taken inside the window', () => {
    // Window [10, 30). Two events inside, one outside.
    const dtEvents = Events.start()
      .damageTaken(EVISCERATE, '0:15', 300)
      .damageTaken(EVISCERATE, '0:25', 500)
      .damageTaken(EVISCERATE, '0:35', 9999) // after window end - excluded by half-open boundary
      .build();
    const [pw] = computePlayerDefensiveWindows([window], dtEvents, FIGHT_START);
    expect(pw.window_damage).toBe(800);
  });

  it('caps the ability breakdown at 6 entries', () => {
    let dt = Events.start();
    for (let i = 0; i < 8; i++) dt = dt.damageTaken(1000 + i, '0:15', (i + 1) * 100);

    const [pw] = computePlayerDefensiveWindows([window], dt.build(), FIGHT_START);

    expect(pw.ability_breakdown).toHaveLength(6);
  });
});
