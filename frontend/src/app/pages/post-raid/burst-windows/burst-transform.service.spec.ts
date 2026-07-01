import { describe, it, expect } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { WclApiService } from '../../../core/services/wcl-api';
import { DataFileApiService } from '../../../core/services/data-file-api';
import { WclEvent } from '../../../core/models/wcl.models';
import {
  BurstTransformService, cdTimings, findParseWindows, clusterParseWindows, cdSpellIds, ParseWindow,
  toParseRankings, bucketDamagePerBin, forwardRollingDamage, detectDenseRuns, trimRunToDamage,
  windowAbilityBreakdown, BinRun,
} from './burst-transform.service';
import { SHADOW_BLADES, SHADOW_BLADES_DAMAGE, EVISCERATE, BLACK_POWDER } from '../../../../testing/spell-ids';

function cast(spellId: number, atS: number): WclEvent {
  return { type: 'cast', timestamp: atS * 1000, abilityGameID: spellId };
}
function damage(spellId: number, atS: number, amount: number): WclEvent {
  return { type: 'damage', timestamp: atS * 1000, abilityGameID: spellId, amount };
}
/** Call `findParseWindows` with the common fixed-fight defaults, overriding per case. */
function scanWindows(
  damageEvents: WclEvent[], fightEndMs: number,
  overrides: { timings?: ReturnType<typeof cdTimings>; casts?: WclEvent[]; abilityNames?: Map<number, string> } = {},
): ParseWindow[] {
  return findParseWindows({
    damage: damageEvents, fightStartMs: 0, fightEndMs,
    timings: overrides.timings ?? [], casts: overrides.casts ?? [], abilityNames: overrides.abilityNames ?? new Map(),
  });
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

describe('bucketDamagePerBin', () => {
  // Three hits in one 1s bin (bin 1) sum; an out-of-range hit clamps into the last bin.
  it('sums hits into their fight-relative bin and clamps out-of-range hits', () => {
    const FIRST_HIT = 100;
    const SECOND_HIT = 200;
    const LATE_HIT = 50;
    const BIN_COUNT = 3;
    // hit timestamps in ms (DamageHit = [ts, dmg, abilityId]); ts 1000-1999 -> bin 1.
    const hits: [number, number, number][] = [
      [1000, FIRST_HIT, EVISCERATE], [1500, SECOND_HIT, EVISCERATE], [999_000, LATE_HIT, EVISCERATE],
    ];
    expect(bucketDamagePerBin(hits, 0, BIN_COUNT)).toEqual([0, FIRST_HIT + SECOND_HIT, LATE_HIT]);
  });

  it('clamps a pre-fight hit (negative offset) into bin 0', () => {
    const PRE_FIGHT_HIT = 70;
    expect(bucketDamagePerBin([[-5000, PRE_FIGHT_HIT, EVISCERATE]], 0, 2)).toEqual([PRE_FIGHT_HIT, 0]);
  });
});

describe('forwardRollingDamage', () => {
  // Each bin sums itself + the next ROLL_BINS-1; near the end the window truncates.
  it('sums each bin with the next rollBins-1, truncating at the array end', () => {
    const ROLL = 3;
    const perBin = [1, 2, 3, 4];
    // bin0:1+2+3=6, bin1:2+3+4=9, bin2:3+4=7, bin3:4=4
    expect(forwardRollingDamage(perBin, ROLL)).toEqual([6, 9, 7, 4]);
  });

  it('equals the input when rollBins is 1', () => {
    expect(forwardRollingDamage([5, 0, 8], 1)).toEqual([5, 0, 8]);
  });
});

describe('detectDenseRuns', () => {
  const THRESHOLD = 10;
  const MERGE_GAP = 2;

  it('opens a run on the first at-threshold bin (strict >=) and closes it at the last', () => {
    // Bins 1..2 clear THRESHOLD; bin 0 and 3 do not -> run [1,2].
    expect(detectDenseRuns([5, THRESHOLD, THRESHOLD, 5], THRESHOLD, MERGE_GAP)).toEqual([{ startBin: 1, endBin: 2 }]);
  });

  it('treats a bin exactly one below threshold as not dense', () => {
    expect(detectDenseRuns([THRESHOLD - 1, THRESHOLD - 1], THRESHOLD, MERGE_GAP)).toEqual([]);
  });

  it('bridges a gap of exactly mergeGapBins sub-threshold bins', () => {
    // dense, gap, gap, dense -> the 2-bin gap (<= MERGE_GAP) bridges into one run.
    expect(detectDenseRuns([THRESHOLD, 0, 0, THRESHOLD], THRESHOLD, MERGE_GAP)).toEqual([{ startBin: 0, endBin: 3 }]);
  });

  it('splits a gap of mergeGapBins+1 sub-threshold bins into two runs', () => {
    // dense, gap, gap, gap, dense -> the 3-bin gap (> MERGE_GAP) finalizes the first run.
    expect(detectDenseRuns([THRESHOLD, 0, 0, 0, THRESHOLD], THRESHOLD, MERGE_GAP))
      .toEqual([{ startBin: 0, endBin: 0 }, { startBin: 4, endBin: 4 }]);
  });

  it('returns [] when no bin clears the threshold', () => {
    expect(detectDenseRuns([0, 1, 2], THRESHOLD, MERGE_GAP)).toEqual([]);
  });
});

describe('trimRunToDamage', () => {
  it('snaps a run to the first and last bins that carry damage', () => {
    // Run spans bins 0..4, but only bins 1..3 carry damage.
    const run: BinRun = { startBin: 0, endBin: 4 };
    expect(trimRunToDamage(run, [0, 5, 6, 7, 0])).toEqual({ startBin: 1, endBin: 3 });
  });

  it('returns null when the run carries no damage at all', () => {
    expect(trimRunToDamage({ startBin: 0, endBin: 2 }, [0, 0, 0])).toBeNull();
  });

  it('keeps a fully-dense run unchanged', () => {
    expect(trimRunToDamage({ startBin: 1, endBin: 2 }, [0, 4, 5, 0])).toEqual({ startBin: 1, endBin: 2 });
  });
});

describe('windowAbilityBreakdown', () => {
  const nameOf = (spellId: number): string => new Map([[EVISCERATE, 'Eviscerate'], [BLACK_POWDER, 'Black Powder']]).get(spellId) ?? `Spell ${spellId}`;

  it('ranks abilities by window damage, counts casts by name, and flags passive abilities', () => {
    const EVIS_DMG = 600;
    const BP_DMG = 400;
    // DamageHit = [ts, dmg, abilityId]; window is [1000ms, 3000ms).
    const windowHits: [number, number, number][] = [[1000, EVIS_DMG, EVISCERATE], [1500, BP_DMG, BLACK_POWDER]];
    // CastRow = [ts, abilityId]; one Eviscerate cast in-window, one Black Powder cast out-of-window.
    const castRows: [number, number][] = [[1200, EVISCERATE], [9000, BLACK_POWDER]];
    const castNamesInParse = new Set(['Eviscerate']);
    const breakdown = windowAbilityBreakdown(windowHits, castRows, 1000, 3000, nameOf, castNamesInParse);
    expect(breakdown).toEqual([
      { spell_id: EVISCERATE, damage: EVIS_DMG, casts: 1, is_passive: false },
      // Black Powder was cast somewhere in the parse? No -> passive, and 0 in-window casts.
      { spell_id: BLACK_POWDER, damage: BP_DMG, casts: 0, is_passive: true },
    ]);
  });

  it('excludes a cast exactly on the half-open window end', () => {
    const HIT_DMG = 500;
    const windowHits: [number, number, number][] = [[1000, HIT_DMG, EVISCERATE]];
    // A cast at exactly endMs (3000) is excluded; one just inside (2999) counts.
    const castRows: [number, number][] = [[3000, EVISCERATE], [2999, EVISCERATE]];
    const breakdown = windowAbilityBreakdown(windowHits, castRows, 1000, 3000, nameOf, new Set(['Eviscerate']));
    expect(breakdown[0].casts).toBe(1);
  });

  it('caps the breakdown at the top 6 abilities by damage', () => {
    const ABILITY_COUNT = 8;
    // Eight abilities, descending damage; only the top 6 survive.
    const windowHits: [number, number, number][] = Array.from(
      { length: ABILITY_COUNT }, (_, index) => [1000, (ABILITY_COUNT - index) * 100, index + 1] as [number, number, number],
    );
    const breakdown = windowAbilityBreakdown(windowHits, [], 1000, 3000, nameOf, new Set());
    expect(breakdown).toHaveLength(6);
    expect(breakdown[0].damage).toBe(ABILITY_COUNT * 100);
  });
});

describe('findParseWindows', () => {
  // A contiguous burst (damage at 10,11,12,13) on a long fight forms one dense run,
  // trimmed to the bins that actually carry damage, so it measures [10s, 14s).
  it('detects and measures a damage-density burst as a single window', () => {
    const windows = scanWindows(burstAt(10), LONG_FIGHT_MS);
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({ time_s: 10, window_length_s: 4, window_damage: 4 * BIN_DAMAGE });
    expect(windows[0].ability_breakdown[0]).toMatchObject({ spell_id: SHADOW_BLADES_DAMAGE, damage: 4 * BIN_DAMAGE });
  });

  it('returns no window for sparse uniform low damage', () => {
    // 100/s for 10s is perfectly flat: no bin's rolling damage clears the density threshold.
    expect(scanWindows(uniformDamage(SHADOW_BLADES_DAMAGE, 10, 100), 10_000)).toHaveLength(0);
  });

  it('returns [] for no damage, zero total, or a non-positive fight length', () => {
    expect(scanWindows([], LONG_FIGHT_MS)).toEqual([]);
    expect(scanWindows([damage(SHADOW_BLADES_DAMAGE, 10, 0)], LONG_FIGHT_MS)).toEqual([]);
    expect(scanWindows([damage(SHADOW_BLADES_DAMAGE, 10, BIN_DAMAGE)], 0)).toEqual([]);
  });

  // An isolated spike's rolling damage equals its own value; the dense comparison is
  // strict `>=`, and the window then trims to the spike's own bin (t=10). The anchor at
  // t=50 holds the remaining damage so TOTAL_DAMAGE (and thus the threshold) stays fixed.
  it('keeps a spike whose rolling damage is exactly at the density threshold', () => {
    const spikeAtThreshold = [damage(EVISCERATE, 10, DENSITY_THRESHOLD), damage(BLACK_POWDER, 50, TOTAL_DAMAGE - DENSITY_THRESHOLD)];
    const windows = scanWindows(spikeAtThreshold, HUNDRED_S_FIGHT_MS);
    expect(windows.some(window => window.time_s === 10)).toBe(true);
  });

  it('drops a spike whose rolling damage is just below the density threshold', () => {
    const spikeBelow = [damage(EVISCERATE, 10, DENSITY_THRESHOLD - 1), damage(BLACK_POWDER, 50, TOTAL_DAMAGE - DENSITY_THRESHOLD + 1)];
    const windows = scanWindows(spikeBelow, HUNDRED_S_FIGHT_MS);
    expect(windows.some(window => window.time_s === 10)).toBe(false);
  });

  it('bridges two dense runs separated by 2 sub-threshold bins into one window', () => {
    // Spikes 5 bins apart (t=10, t=15) -> a 2-bin gap -> merged, trimmed to [10s, 16s).
    const windows = scanWindows([damage(EVISCERATE, 10, BIN_DAMAGE), damage(BLACK_POWDER, 15, BIN_DAMAGE)], HUNDRED_S_FIGHT_MS);
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({ time_s: 10, window_length_s: 6, window_damage: 2 * BIN_DAMAGE });
  });

  it('keeps two dense runs separated by 3 sub-threshold bins as separate windows', () => {
    // Spikes 6 bins apart (t=10, t=16) -> a 3-bin gap -> not merged; each trims to its bin.
    const windows = scanWindows([damage(EVISCERATE, 10, BIN_DAMAGE), damage(BLACK_POWDER, 16, BIN_DAMAGE)], HUNDRED_S_FIGHT_MS);
    expect(windows).toHaveLength(2);
    expect(windows[0]).toMatchObject({ time_s: 10, window_length_s: 1 });
    expect(windows[1]).toMatchObject({ time_s: 16, window_length_s: 1 });
  });

  it('drops a dense window below the significance share of fight damage', () => {
    // Spike of BIN_DAMAGE beside a 100x anchor: BIN_DAMAGE / (101 * BIN_DAMAGE) < SIGNIFICANCE_PCT -> dropped.
    const windows = scanWindows([damage(EVISCERATE, 10, BIN_DAMAGE), damage(BLACK_POWDER, 500, 100 * BIN_DAMAGE)], 1_000_000);
    expect(windows.some(window => window.time_s === 10)).toBe(false);
  });

  it('keeps a dense window at or above the significance share of fight damage', () => {
    // 600 of 10600 total = 5.66% >= SIGNIFICANCE_PCT -> kept.
    const significantDamage = 600;
    const windows = scanWindows([damage(EVISCERATE, 10, significantDamage), damage(BLACK_POWDER, 50, 10_000)], HUNDRED_S_FIGHT_MS);
    expect(windows.some(window => window.time_s === 10 && window.window_damage === significantDamage)).toBe(true);
  });

  it('excludes a hit exactly on the window end (half-open)', () => {
    // Burst 10..13 -> window [10s, 14s). A small probe at exactly 14s is too small to
    // extend the dense run, so the window geometry is fixed and the 14s hit is excluded.
    const windows = scanWindows([...burstAt(10), damage(BLACK_POWDER, 14, 10)], LONG_FIGHT_MS);
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({ window_length_s: 4, window_damage: 4 * BIN_DAMAGE });
    expect(windows[0].ability_breakdown.map(ability => ability.spell_id)).not.toContain(BLACK_POWDER);
  });

  it('includes a hit just inside the window end', () => {
    const probeDamage = 10;
    const windows = scanWindows([...burstAt(10), damage(BLACK_POWDER, 13.999, probeDamage)], LONG_FIGHT_MS);
    expect(windows[0]).toMatchObject({ window_length_s: 4, window_damage: 4 * BIN_DAMAGE + probeDamage });
    expect(windows[0].ability_breakdown.map(ability => ability.spell_id)).toContain(BLACK_POWDER);
  });

  it('attributes a cooldown whose cast lands inside the window', () => {
    // Window is [10s, 14s); a Shadow Blades cast at 10s is inside.
    const timings = cdTimings([cast(SHADOW_BLADES, 10)], [{ name: 'Shadow Blades', spell_id: SHADOW_BLADES, cooldown: 90 }], 0);
    const windows = scanWindows(burstAt(10), LONG_FIGHT_MS, { timings, casts: [cast(SHADOW_BLADES, 10)] });
    expect(windows[0].active_cds).toEqual(['Shadow Blades']);
  });

  it('does not attribute a cooldown cast on the half-open window end', () => {
    // A cast at 14s sits exactly on the window end -> not attributed.
    const timings = cdTimings([cast(SHADOW_BLADES, 14)], [{ name: 'Shadow Blades', spell_id: SHADOW_BLADES, cooldown: 90 }], 0);
    const windows = scanWindows(burstAt(10), LONG_FIGHT_MS, { timings, casts: [cast(SHADOW_BLADES, 14)] });
    expect(windows[0].active_cds).toEqual([]);
  });

  it('marks an ability with no matching cast event as passive', () => {
    // Eviscerate deals the burst damage but was never cast (only Shadow Blades was).
    const names = new Map([[SHADOW_BLADES, 'Shadow Blades'], [SHADOW_BLADES_DAMAGE, 'Eviscerate']]);
    const windows = scanWindows(burstAt(10), LONG_FIGHT_MS, { casts: [cast(SHADOW_BLADES, 10)], abilityNames: names });
    expect(windows[0].ability_breakdown[0]).toMatchObject({ spell_id: SHADOW_BLADES_DAMAGE, is_passive: true });
  });

  it('marks an actively cast ability as not passive', () => {
    const names = new Map([[SHADOW_BLADES_DAMAGE, 'Eviscerate']]);
    const windows = scanWindows(burstAt(10), LONG_FIGHT_MS, { casts: [cast(SHADOW_BLADES_DAMAGE, 10)], abilityNames: names });
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

  // Consensus gate: survive only when a cluster holds at least max(2, CLUSTER_MIN_FRAC *
  // sampleCount) member parses. With sampleCount = 10 the floor is 4.
  it('keeps a cluster present in enough parses', () => {
    const four = [window(10), window(11), window(12), window(13)];
    expect(clusterParseWindows(four, 10)).toHaveLength(1);
  });

  it('drops a cluster present in fewer parses than the consensus floor', () => {
    const three = [window(10), window(11), window(12)];
    expect(clusterParseWindows(three, 10)).toHaveLength(0);
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
    const bench = await TestBed.inject(BurstTransformService).getBench('SubtletyRogue', 1);
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
    const bench = await TestBed.inject(BurstTransformService).getBench('SubtletyRogue', 1);
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
    expect(await TestBed.inject(BurstTransformService).getBench('SubtletyRogue', 1)).toBeNull();
  });
});
