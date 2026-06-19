import { describe, it, expect } from 'vitest';
import { BurstWindowsComponent } from './burst-windows';
import { BurstWindow, PlayerBurstWindow } from '../../../core/models/analysis.models';
import { ComparisonWindow } from '../../../shared/components/window-comparison/window-comparison';
import { mountVm } from '../../../../testing/component-harness';

const topWindow: BurstWindow = {
  time_s: 10,
  window_length_s: 20,
  dmg_avg: 1000,
  dmg_min: 800,
  dmg_max: 1300,
  dmg_stddev: 50,
  common_cds: [],
  ability_breakdown: [],
};

function windowsFor(opts: { player?: PlayerBurstWindow | null; fightDuration?: number; top?: BurstWindow }): ComparisonWindow[] {
  const { vm } = mountVm(BurstWindowsComponent, {
    topWindows: [opts.top ?? topWindow],
    playerWindows: opts.player ? [opts.player] : [],
    fightDuration: opts.fightDuration ?? 300,
    cdSpellIds: {},
  });
  return (vm['windows'] as () => ComparisonWindow[])();
}

describe('BurstWindowsComponent windows / status', () => {
  // Window dmg avg 1000, min 800, sd 50 -> "bad" below 750, "warn" below 950, else "good".
  it('marks the player "bad" when damage falls below min - stddev', () => {
    expect(windowsFor({ player: { window_damage: 700 } })[0].status).toBe('bad');
  });

  it('marks the player "warn" when damage is short of the average but above the bad threshold', () => {
    expect(windowsFor({ player: { window_damage: 900 } })[0].status).toBe('warn');
  });

  it('marks the player "good" when damage matches the top-parse average', () => {
    expect(windowsFor({ player: { window_damage: 1000 } })[0].status).toBe('good');
  });

  it('mutes a window that the fight never reached', () => {
    expect(windowsFor({ player: { window_damage: 1000 }, fightDuration: 5 })[0].status).toBe('muted');
  });

  it('mutes a reached window with no player data (unknown, not a failure)', () => {
    expect(windowsFor({ player: null })[0].status).toBe('muted');
  });

  it('exposes the window time range and player overview value', () => {
    const [w] = windowsFor({ player: { window_damage: 950 } });
    expect(w.timeStartS).toBe(10);
    expect(w.timeEndS).toBe(30); // time_s + window_length_s
    expect(w.overview.playerPct).toBe(950);
  });
});
