import { describe, it, expect } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { WclApiService } from '../../../core/services/wcl-api';
import { DataFileApiService } from '../../../core/services/data-file-api';
import { WclEvent } from '../../../core/models/wcl.models';
import {
  BurstTransformService, cdTimings, findParseWindows, clusterParseWindows, cdSpellIds, ParseWindow,
  toParseRankings,
} from './burst-transform.service';
import { SHADOW_BLADES, SHADOW_BLADES_DAMAGE, EVISCERATE, BLACK_POWDER } from '../../../../testing/spell-ids';

function cast(spellId: number, atS: number): WclEvent {
  return { type: 'cast', timestamp: atS * 1000, abilityGameID: spellId };
}
function damage(spellId: number, atS: number, amount: number): WclEvent {
  return { type: 'damage', timestamp: atS * 1000, abilityGameID: spellId, amount };
}
/** A flat damage stream: `amount` at every second in [0, seconds). */
function uniformDamage(spellId: number, seconds: number, amount: number): WclEvent[] {
  return Array.from({ length: seconds }, (_, i) => damage(spellId, i, amount));
}

// Fight lengths used by the window-detection fixtures.
const LONG_FIGHT_MS = 300_000;
const HUNDRED_S_FIGHT_MS = 100_000;
// Per-second damage that makes a bin comfortably "dense" on a long fight.
const BIN_DAMAGE = 1000;
// On a HUNDRED_S_FIGHT (100 bins) carrying TOTAL_DAMAGE, the density threshold works out
// to THRESHOLD_MULT (1.6) x mean rolling damage = 1.6 * (TOTAL_DAMAGE / 100) * 3 =
// DENSITY_THRESHOLD; the quantile floor is 0 since the rolling-damage distribution is mostly zeros.
const TOTAL_DAMAGE = 1000;
const DENSITY_THRESHOLD = 48;

/** A 4-bin damage burst (BIN_DAMAGE at startS..startS+3) from the Shadow Blades damage id. */
function burstAt(startS: number): WclEvent[] {
  return [0, 1, 2, 3].map(offset => damage(SHADOW_BLADES_DAMAGE, startS + offset, BIN_DAMAGE));
}

/* ----------------------------- pure functions ----------------------------- */

describe('toParseRankings', () => {
  it('maps raw rankings to fetchable parses and caps at count', () => {
    const raw = [
      { name: 'P1', report: { code: 'r1', fightID: 1 } },
      { name: 'P2', report: { code: 'r2', fightID: 2 } },
      { name: 'P3', report: { code: 'r3', fightID: 3 } },
    ];
    expect(toParseRankings(raw, 2)).toEqual([
      { player: 'P1', report_code: 'r1', fight_id: 1 },
      { player: 'P2', report_code: 'r2', fight_id: 2 },
    ]);
  });

  it('drops anonymized "Character N-N" names and rows without a report code', () => {
    const raw = [
      { name: 'Character 123-456', report: { code: 'r1', fightID: 1 } },
      { name: 'Real', report: { fightID: 2 } },
      { name: 'Keep', report: { code: 'r3', fightID: 3 } },
    ];
    expect(toParseRankings(raw, 10)).toEqual([{ player: 'Keep', report_code: 'r3', fight_id: 3 }]);
  });
});

describe('cdSpellIds', () => {
  it('maps cooldown + defensive names to spell ids, skipping missing ids', () => {
    expect(cdSpellIds(
      [{ name: 'Shadow Blades', spell_id: 121471, cooldown: 90 }, { name: 'NoId', spell_id: 0, cooldown: 60 }],
      [{ name: 'Cloak', spell_id: 31224, cooldown: 120 }],
    )).toEqual({ 'Shadow Blades': 121471, 'Cloak': 31224 });
  });
});

describe('cdTimings', () => {
  it('collects per-cooldown cast times in fight-relative seconds (no duration read)', () => {
    const timings = cdTimings([cast(121471, 30), cast(121471, 10), cast(999, 5)], [{ name: 'Shadow Blades', spell_id: 121471, cooldown: 90 }], 0);
    expect(timings).toEqual([{ name: 'Shadow Blades', castTimesS: [10, 30] }]);
  });
});

describe('findParseWindows', () => {
  // A contiguous burst (damage at 10,11,12,13) on a long fight forms one dense run,
  // trimmed to the bins that actually carry damage, so it measures [10s, 14s).
  it('detects and measures a damage-density burst as a single window', () => {
    const windows = findParseWindows(burstAt(10), 0, LONG_FIGHT_MS, [], [], new Map());
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({ time_s: 10, window_length_s: 4, window_damage: 4 * BIN_DAMAGE });
    expect(windows[0].ability_breakdown[0]).toMatchObject({ spell_id: SHADOW_BLADES_DAMAGE, damage: 4 * BIN_DAMAGE });
  });

  it('returns no window for sparse uniform low damage', () => {
    // 100/s for 10s is perfectly flat: no bin's rolling damage clears the density threshold.
    expect(findParseWindows(uniformDamage(SHADOW_BLADES_DAMAGE, 10, 100), 0, 10_000, [], [], new Map())).toHaveLength(0);
  });

  it('returns [] for no damage, zero total, or a non-positive fight length', () => {
    expect(findParseWindows([], 0, LONG_FIGHT_MS, [], [], new Map())).toEqual([]);
    expect(findParseWindows([damage(SHADOW_BLADES_DAMAGE, 10, 0)], 0, LONG_FIGHT_MS, [], [], new Map())).toEqual([]);
    expect(findParseWindows([damage(SHADOW_BLADES_DAMAGE, 10, BIN_DAMAGE)], 0, 0, [], [], new Map())).toEqual([]);
  });

  // An isolated spike's rolling damage equals its own value; the dense comparison is
  // strict `>=`, and the window then trims to the spike's own bin (t=10). The anchor at
  // t=50 holds the remaining damage so TOTAL_DAMAGE (and thus the threshold) stays fixed.
  it('keeps a spike whose rolling damage is exactly at the density threshold', () => {
    const spikeAtThreshold = [damage(EVISCERATE, 10, DENSITY_THRESHOLD), damage(BLACK_POWDER, 50, TOTAL_DAMAGE - DENSITY_THRESHOLD)];
    const windows = findParseWindows(spikeAtThreshold, 0, HUNDRED_S_FIGHT_MS, [], [], new Map());
    expect(windows.some(window => window.time_s === 10)).toBe(true);
  });

  it('drops a spike whose rolling damage is just below the density threshold', () => {
    const spikeBelow = [damage(EVISCERATE, 10, DENSITY_THRESHOLD - 1), damage(BLACK_POWDER, 50, TOTAL_DAMAGE - DENSITY_THRESHOLD + 1)];
    const windows = findParseWindows(spikeBelow, 0, HUNDRED_S_FIGHT_MS, [], [], new Map());
    expect(windows.some(window => window.time_s === 10)).toBe(false);
  });

  it('bridges two dense runs separated by 2 sub-threshold bins into one window', () => {
    // Spikes 5 bins apart (t=10, t=15) -> a 2-bin gap -> merged, trimmed to [10s, 16s).
    const windows = findParseWindows([damage(EVISCERATE, 10, BIN_DAMAGE), damage(BLACK_POWDER, 15, BIN_DAMAGE)], 0, HUNDRED_S_FIGHT_MS, [], [], new Map());
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({ time_s: 10, window_length_s: 6, window_damage: 2 * BIN_DAMAGE });
  });

  it('keeps two dense runs separated by 3 sub-threshold bins as separate windows', () => {
    // Spikes 6 bins apart (t=10, t=16) -> a 3-bin gap -> not merged; each trims to its bin.
    const windows = findParseWindows([damage(EVISCERATE, 10, BIN_DAMAGE), damage(BLACK_POWDER, 16, BIN_DAMAGE)], 0, HUNDRED_S_FIGHT_MS, [], [], new Map());
    expect(windows).toHaveLength(2);
    expect(windows[0]).toMatchObject({ time_s: 10, window_length_s: 1 });
    expect(windows[1]).toMatchObject({ time_s: 16, window_length_s: 1 });
  });

  it('drops a dense window below the significance share of fight damage', () => {
    // Spike of BIN_DAMAGE beside a 100x anchor: BIN_DAMAGE / (101 * BIN_DAMAGE) < SIGNIFICANCE_PCT -> dropped.
    const windows = findParseWindows([damage(EVISCERATE, 10, BIN_DAMAGE), damage(BLACK_POWDER, 500, 100 * BIN_DAMAGE)], 0, 1_000_000, [], [], new Map());
    expect(windows.some(window => window.time_s === 10)).toBe(false);
  });

  it('keeps a dense window at or above the significance share of fight damage', () => {
    // 600 of 10600 total = 5.66% >= SIGNIFICANCE_PCT -> kept.
    const significantDamage = 600;
    const windows = findParseWindows([damage(EVISCERATE, 10, significantDamage), damage(BLACK_POWDER, 50, 10_000)], 0, HUNDRED_S_FIGHT_MS, [], [], new Map());
    expect(windows.some(window => window.time_s === 10 && window.window_damage === significantDamage)).toBe(true);
  });

  it('excludes a hit exactly on the window end (half-open)', () => {
    // Burst 10..13 -> window [10s, 14s). A small probe at exactly 14s is too small to
    // extend the dense run, so the window geometry is fixed and the 14s hit is excluded.
    const windows = findParseWindows([...burstAt(10), damage(BLACK_POWDER, 14, 10)], 0, LONG_FIGHT_MS, [], [], new Map());
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({ window_length_s: 4, window_damage: 4 * BIN_DAMAGE });
    expect(windows[0].ability_breakdown.map(ability => ability.spell_id)).not.toContain(BLACK_POWDER);
  });

  it('includes a hit just inside the window end', () => {
    const probeDamage = 10;
    const windows = findParseWindows([...burstAt(10), damage(BLACK_POWDER, 13.999, probeDamage)], 0, LONG_FIGHT_MS, [], [], new Map());
    expect(windows[0]).toMatchObject({ window_length_s: 4, window_damage: 4 * BIN_DAMAGE + probeDamage });
    expect(windows[0].ability_breakdown.map(ability => ability.spell_id)).toContain(BLACK_POWDER);
  });

  it('attributes a cooldown whose cast lands inside the window', () => {
    // Window is [10s, 14s); a Shadow Blades cast at 10s is inside.
    const timings = cdTimings([cast(SHADOW_BLADES, 10)], [{ name: 'Shadow Blades', spell_id: SHADOW_BLADES, cooldown: 90 }], 0);
    const windows = findParseWindows(burstAt(10), 0, LONG_FIGHT_MS, timings, [cast(SHADOW_BLADES, 10)], new Map());
    expect(windows[0].active_cds).toEqual(['Shadow Blades']);
  });

  it('does not attribute a cooldown cast on the half-open window end', () => {
    // A cast at 14s sits exactly on the window end -> not attributed.
    const timings = cdTimings([cast(SHADOW_BLADES, 14)], [{ name: 'Shadow Blades', spell_id: SHADOW_BLADES, cooldown: 90 }], 0);
    const windows = findParseWindows(burstAt(10), 0, LONG_FIGHT_MS, timings, [cast(SHADOW_BLADES, 14)], new Map());
    expect(windows[0].active_cds).toEqual([]);
  });

  it('marks an ability with no matching cast event as passive', () => {
    // Eviscerate deals the burst damage but was never cast (only Shadow Blades was).
    const names = new Map([[SHADOW_BLADES, 'Shadow Blades'], [SHADOW_BLADES_DAMAGE, 'Eviscerate']]);
    const windows = findParseWindows(burstAt(10), 0, LONG_FIGHT_MS, [], [cast(SHADOW_BLADES, 10)], names);
    expect(windows[0].ability_breakdown[0]).toMatchObject({ spell_id: SHADOW_BLADES_DAMAGE, is_passive: true });
  });

  it('marks an actively cast ability as not passive', () => {
    const names = new Map([[SHADOW_BLADES_DAMAGE, 'Eviscerate']]);
    const windows = findParseWindows(burstAt(10), 0, LONG_FIGHT_MS, [], [cast(SHADOW_BLADES_DAMAGE, 10)], names);
    expect(windows[0].ability_breakdown[0]).toMatchObject({ spell_id: SHADOW_BLADES_DAMAGE, is_passive: false });
  });
});

describe('clusterParseWindows', () => {
  const ABILITY_DAMAGE = 600;
  const window = (timeS: number, isPassive = false): ParseWindow => ({
    time_s: timeS, window_length_s: 6, window_damage: BIN_DAMAGE, active_cds: ['Shadow Blades'],
    ability_breakdown: [{ spell_id: SHADOW_BLADES_DAMAGE, damage: ABILITY_DAMAGE, casts: 2, is_passive: isPassive }],
  });

  it('emits a cluster present in enough parses, with common cds + ability stats', () => {
    const out = clusterParseWindows([window(10), window(11)], 2);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ time_s: 10.5, common_cds: ['Shadow Blades'], dmg_avg: BIN_DAMAGE, window_length_s: 6 });
    expect(out[0].ability_breakdown[0]).toMatchObject({ spell_id: SHADOW_BLADES_DAMAGE, avg_damage: ABILITY_DAMAGE, count: 2 });
  });

  it('does not emit avg_targets', () => {
    expect(clusterParseWindows([window(10), window(11)], 2)[0]).not.toHaveProperty('avg_targets');
  });

  // Majority gate: survive only when a cluster holds at least max(2, CLUSTER_MIN_FRAC *
  // sampleCount) member parses. With sampleCount = 10 the floor is 5.
  it('keeps a cluster present in a majority of parses', () => {
    const five = [window(10), window(11), window(12), window(13), window(14)];
    expect(clusterParseWindows(five, 10)).toHaveLength(1);
  });

  it('drops a cluster present in fewer than the majority of parses', () => {
    const four = [window(10), window(11), window(12), window(13)];
    expect(clusterParseWindows(four, 10)).toHaveLength(0);
  });

  it('marks a clustered ability passive only when every member never cast it', () => {
    expect(clusterParseWindows([window(10, true), window(11, true)], 2)[0].ability_breakdown[0])
      .toMatchObject({ is_passive: true });
    // One member did cast it -> the clustered ability is not passive.
    expect(clusterParseWindows([window(10, true), window(11, false)], 2)[0].ability_breakdown[0])
      .toMatchObject({ is_passive: false });
  });
});

/* ----------------------------- service (end to end, fake client) ----------------------------- */

function reportFor(playerId: number, playerName: string, fightId: number) {
  return {
    title: 't',
    fights: [{ id: fightId, name: 'Boss', startTime: 0, endTime: 300_000, kill: true, encounterID: 1, friendlyPlayers: [] }],
    masterData: {
      actors: [{ id: playerId, name: playerName, subType: 'Rogue', server: '' }],
      abilities: [{ gameID: SHADOW_BLADES_DAMAGE, name: 'Eviscerate', icon: 'x' }],
    },
  };
}

// A damage-density burst at 10,11,12s overlaps the Shadow Blades cast at 10s, so each
// parse yields one measured window with Shadow Blades attributed inside it.
const burstDamage = [damage(SHADOW_BLADES_DAMAGE, 10, BIN_DAMAGE), damage(SHADOW_BLADES_DAMAGE, 11, BIN_DAMAGE), damage(SHADOW_BLADES_DAMAGE, 12, BIN_DAMAGE)];
const wclFake = {
  getRankings: async () => [
    { name: 'P1', report: { code: 'r1', fightID: 1 } },
    { name: 'P2', report: { code: 'r2', fightID: 2 } },
  ],
  getReport: async (code: string) => (code === 'r1' ? reportFor(10, 'P1', 1) : reportFor(20, 'P2', 2)),
  getAllEvents: async (_code: string, _fightId: number, dataType: string) =>
    dataType === 'Casts' ? [cast(SHADOW_BLADES, 10)] : burstDamage,
  // Resolves a real icon + name for every requested spell id (gameData.ability).
  getAbilities: async (ids: number[]) =>
    Object.fromEntries(ids.map(id => [id, { icon: `icon_${id}`, name: `name_${id}` }])),
};
const filesFake = {
  getRulebook: async () => ({
    spec: 'SubtletyRogue',
    major_cooldowns: [{ name: 'Shadow Blades', spell_id: SHADOW_BLADES, cooldown: 90, duration: 20 }],
    defensives: [],
  }),
};

describe('BurstTransformService (live, in-browser)', () => {
  it('computes a clustered burst bench from the top parses', async () => {
    TestBed.configureTestingModule({
      providers: [
        { provide: WclApiService, useValue: wclFake as unknown as WclApiService },
        { provide: DataFileApiService, useValue: filesFake as unknown as DataFileApiService },
      ],
    });
    const bench = await TestBed.inject(BurstTransformService).getBurstBench('SubtletyRogue', 1);
    expect(bench).not.toBeNull();
    expect(bench!.sample_count).toBe(2);
    expect(bench!.encounter_name).toBe('Boss');
    expect(bench!.cd_spell_ids).toEqual({ 'Shadow Blades': SHADOW_BLADES });
    expect(bench!.windows).toHaveLength(1);
    expect(bench!.windows[0].common_cds).toContain('Shadow Blades');
    // ability_icons is complete: header cooldown AND every window ability resolved by id.
    expect(bench!.ability_icons[SHADOW_BLADES]).toEqual({ icon: `icon_${SHADOW_BLADES}`, name: `name_${SHADOW_BLADES}` });
    expect(bench!.ability_icons[SHADOW_BLADES_DAMAGE]).toEqual({ icon: `icon_${SHADOW_BLADES_DAMAGE}`, name: `name_${SHADOW_BLADES_DAMAGE}` });
  });

  it('backfills past a private (unfetchable) top parse to keep the sample count full', async () => {
    const candidates = Array.from({ length: 11 }, (_, i) => ({ name: `P${i + 1}`, report: { code: `r${i + 1}`, fightID: i + 1 } }));
    const backfillWcl = {
      ...wclFake,
      getRankings: async () => candidates,
      getReport: async (code: string) => {
        if (code === 'r5') throw new Error('You do not have permission to view this report.');
        const idx = Number(code.slice(1));
        return reportFor(idx * 10, `P${idx}`, idx);
      },
    };
    TestBed.configureTestingModule({
      providers: [
        { provide: WclApiService, useValue: backfillWcl as unknown as WclApiService },
        { provide: DataFileApiService, useValue: filesFake as unknown as DataFileApiService },
      ],
    });
    const bench = await TestBed.inject(BurstTransformService).getBurstBench('SubtletyRogue', 1);
    // 11 candidates, one private: the 11th backfills the skipped parse to a full 10.
    expect(bench!.sample_count).toBe(10);
  });

  it('returns null when the spec has no rulebook cooldowns', async () => {
    TestBed.configureTestingModule({
      providers: [
        { provide: WclApiService, useValue: wclFake as unknown as WclApiService },
        { provide: DataFileApiService, useValue: { getRulebook: async () => null } as unknown as DataFileApiService },
      ],
    });
    expect(await TestBed.inject(BurstTransformService).getBurstBench('SubtletyRogue', 1)).toBeNull();
  });
});
