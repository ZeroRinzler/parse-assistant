import { assert, describe, it, expect } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { WclEvent } from '../../../core/models/wcl.models';
import { ok, missing } from '../../../core/result';
import {
  BurstTransformService, cdTimings, findParseWindows, clusterParseWindows, ParseWindow,
  BurstDetectorTuning, DEFAULT_BURST_TUNING,
} from './burst-transform.service';
import {
  SHADOW_BLADES, SHADOW_BLADES_DAMAGE, EVISCERATE, BLACK_POWDER, CLOAK_OF_SHADOWS, WCL_SYNTHETIC_SOURCE_FALLBACK_ID,
  RUPTURE, VANISH, SECRET_TECHNIQUE, SHADOW_DANCE,
} from '../../../../testing/spell-ids';
import { withRelativeS } from '../../../shared/analysis/wcl-projections';
import { cast, damage } from '../../../../testing/builders/events';
import { rulebook } from '../../../../testing/builders/rulebook';
import { abilityLookup, parseRankings, reportsByCode } from '../../../../testing/builders/wcl-fixtures';
import { provideApiFakes } from '../../../../testing/api-fakes';

/** Fixture events build against a fight-start of 0, so stamping is a pass-through to seconds. */
const timed = withRelativeS;

interface ScanOverrides {
  timings?: ReturnType<typeof cdTimings>;
  casts?: WclEvent[];
  abilityNames?: Map<number, string>;
  tuning?: BurstDetectorTuning;
}

function scanWindows(damageEvents: WclEvent[], fightLenS: number, overrides: ScanOverrides = {}): ParseWindow[] {
  return findParseWindows({
    damage: timed(damageEvents, 0), fightLenS,
    timings: overrides.timings ?? [], casts: timed(overrides.casts ?? [], 0), abilityNames: overrides.abilityNames ?? new Map<number, string>(),
  }, overrides.tuning);
}
function uniformDamage(spellId: number, seconds: number, amount: number): WclEvent[] {
  return Array.from({ length: seconds }, (_, i) => damage(spellId, i, amount));
}

const LONG_FIGHT_S = 300;
const HUNDRED_S_FIGHT_S = 100;
const BIN_DAMAGE = 1000;
const TOTAL_DAMAGE = 1000;
const HUNDRED_S_BIN_COUNT = HUNDRED_S_FIGHT_S / DEFAULT_BURST_TUNING.binS;
// Mirrors the detector expression, so a tuning edit moves this bar instead of silently un-pinning the boundary tests.
const MEAN_ROLLING_DAMAGE = (TOTAL_DAMAGE / HUNDRED_S_BIN_COUNT) * DEFAULT_BURST_TUNING.rollBins;
const DENSITY_THRESHOLD = DEFAULT_BURST_TUNING.thresholdMult * MEAN_ROLLING_DAMAGE;

const SIGNIFICANCE_FIGHT_DAMAGE = 10_000;
// The smallest window damage the strict `< significancePct` drop keeps, so the pair below pins both sides of it.
const SIGNIFICANT_SPIKE = SIGNIFICANCE_FIGHT_DAMAGE * DEFAULT_BURST_TUNING.significancePct;
const SIGNIFICANCE_ANCHOR = SIGNIFICANCE_FIGHT_DAMAGE - SIGNIFICANT_SPIKE;

function burstAt(startS: number): WclEvent[] {
  return [0, 1, 2, 3].map(offset => damage(SHADOW_BLADES_DAMAGE, startS + offset, BIN_DAMAGE));
}

describe('cdTimings', () => {
  it('collects per-cooldown cast times in fight-relative seconds (no duration read)', () => {
    const timings = cdTimings(timed([cast(SHADOW_BLADES, 30), cast(SHADOW_BLADES, 10), cast(999, 5)], 0), [{ name: 'Shadow Blades', spell_id: SHADOW_BLADES, cooldown: 90 }]);
    expect(timings).toEqual([{ name: 'Shadow Blades', castTimesS: [10, 30] }]);
  });
});

describe('findParseWindows', () => {
  // A contiguous burst (damage at 10,11,12,13) forms one dense run, trimmed to the bins with damage: [10s, 14s).
  it('detects and measures a damage-density burst as a single window (amount + absorbed)', () => {
    const ABSORBED = 400;
    // The first bin's hit is shielded (amount + absorbed), so the window-damage sum must count absorbed.
    const burst = [
      damage(SHADOW_BLADES_DAMAGE, 10, BIN_DAMAGE - ABSORBED, { absorbed: ABSORBED }),
      ...[1, 2, 3].map(offset => damage(SHADOW_BLADES_DAMAGE, 10 + offset, BIN_DAMAGE)),
    ];
    const windows = scanWindows(burst, LONG_FIGHT_S);
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({ time_s: 10, window_length_s: 4, window_damage: 4 * BIN_DAMAGE });
    assert.exists(windows[0]);
    expect(windows[0].ability_breakdown[0]).toMatchObject({ spell_id: SHADOW_BLADES_DAMAGE, damage: 4 * BIN_DAMAGE });
  });

  it('returns no window for sparse uniform low damage', () => {
    // 100/s for 10s is perfectly flat: no bin's rolling damage clears the density threshold.
    expect(scanWindows(uniformDamage(SHADOW_BLADES_DAMAGE, 10, 100), 10)).toHaveLength(0);
  });

  it('returns [] for no damage, zero total, or a non-positive fight length', () => {
    expect(scanWindows([], LONG_FIGHT_S)).toEqual([]);
    expect(scanWindows([damage(SHADOW_BLADES_DAMAGE, 10, 0)], LONG_FIGHT_S)).toEqual([]);
    expect(scanWindows([damage(SHADOW_BLADES_DAMAGE, 10, BIN_DAMAGE)], 0)).toEqual([]);
  });

  // An isolated spike's rolling damage equals its own value, so the strict `>=` dense check keeps it at its own bin (t=10).
  it('keeps a spike whose rolling damage is exactly at the density threshold', () => {
    const spikeAtThreshold = [damage(EVISCERATE, 10, DENSITY_THRESHOLD), damage(BLACK_POWDER, 50, TOTAL_DAMAGE - DENSITY_THRESHOLD)];
    const windows = scanWindows(spikeAtThreshold, HUNDRED_S_FIGHT_S);
    expect(windows.some(window => window.time_s === 10)).toBe(true);
  });

  it('drops a spike whose rolling damage is just below the density threshold', () => {
    const spikeBelow = [damage(EVISCERATE, 10, DENSITY_THRESHOLD - 1), damage(BLACK_POWDER, 50, TOTAL_DAMAGE - DENSITY_THRESHOLD + 1)];
    const windows = scanWindows(spikeBelow, HUNDRED_S_FIGHT_S);
    expect(windows.some(window => window.time_s === 10)).toBe(false);
  });

  it('bridges two dense runs separated by 2 sub-threshold bins into one window', () => {
    // Spikes 5 bins apart (t=10, t=15) -> a 2-bin gap -> merged, trimmed to [10s, 16s).
    const windows = scanWindows([damage(EVISCERATE, 10, BIN_DAMAGE), damage(BLACK_POWDER, 15, BIN_DAMAGE)], HUNDRED_S_FIGHT_S);
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({ time_s: 10, window_length_s: 6, window_damage: 2 * BIN_DAMAGE });
  });

  it('keeps two dense runs separated by 3 sub-threshold bins as separate windows', () => {
    // Spikes 6 bins apart (t=10, t=16) -> a 3-bin gap -> not merged; each trims to its bin.
    const windows = scanWindows([damage(EVISCERATE, 10, BIN_DAMAGE), damage(BLACK_POWDER, 16, BIN_DAMAGE)], HUNDRED_S_FIGHT_S);
    expect(windows).toHaveLength(2);
    expect(windows[0]).toMatchObject({ time_s: 10, window_length_s: 1 });
    expect(windows[1]).toMatchObject({ time_s: 16, window_length_s: 1 });
  });

  it('splits the bridged pair into two windows under a tuning with no merge gap', () => {
    const noMergeGap: BurstDetectorTuning = { ...DEFAULT_BURST_TUNING, mergeGapBins: 0 };
    // The same t=10/t=15 spikes the default bridges: at mergeGapBins 0 the gap closes the first run instead.
    const spikes = [damage(EVISCERATE, 10, BIN_DAMAGE), damage(BLACK_POWDER, 15, BIN_DAMAGE)];
    const windows = scanWindows(spikes, HUNDRED_S_FIGHT_S, { tuning: noMergeGap });
    expect(windows).toHaveLength(2);
    expect(windows[0]).toMatchObject({ time_s: 10, window_length_s: 1, window_damage: BIN_DAMAGE });
    expect(windows[1]).toMatchObject({ time_s: 15, window_length_s: 1, window_damage: BIN_DAMAGE });
  });

  it('floors the density bar at the rateQuantile rolling bin when the mean-multiple arm is lower', () => {
    const FLAT_FIGHT_S = 10;
    const FLAT_BIN_DAMAGE = 100;
    // Only a full-width forward roll clears the 66th-percentile bar; the trailing rolls truncate and fall under it.
    const FULL_ROLL_BINS = FLAT_FIGHT_S - (DEFAULT_BURST_TUNING.rollBins - 1);
    const quantileFloorOnly: BurstDetectorTuning = { ...DEFAULT_BURST_TUNING, thresholdMult: 0 };
    const flat = uniformDamage(SHADOW_BLADES_DAMAGE, FLAT_FIGHT_S, FLAT_BIN_DAMAGE);
    const windows = scanWindows(flat, FLAT_FIGHT_S, { tuning: quantileFloorOnly });
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({
      time_s: 0, window_length_s: FULL_ROLL_BINS, window_damage: FULL_ROLL_BINS * FLAT_BIN_DAMAGE,
    });
  });

  it('sums two hits landing inside one bin into that bin\'s window', () => {
    const FIRST_HIT = 600;
    const SECOND_HIT = 400;
    // The 10.5s hit floors into bin 10 rather than rounding into bin 11, so one bin carries both.
    const windows = scanWindows([
      damage(EVISCERATE, 10, FIRST_HIT), damage(EVISCERATE, 10.5, SECOND_HIT), damage(BLACK_POWDER, 50, TOTAL_DAMAGE),
    ], HUNDRED_S_FIGHT_S);
    expect(windows.find(window => window.time_s === 10))
      .toMatchObject({ window_length_s: 1, window_damage: FIRST_HIT + SECOND_HIT });
  });

  it('drops a dense window below the significance share of fight damage', () => {
    // Spike of BIN_DAMAGE beside a 100x anchor: 1 of 101 shares, far under significancePct -> dropped.
    const windows = scanWindows([damage(EVISCERATE, 10, BIN_DAMAGE), damage(BLACK_POWDER, 500, 100 * BIN_DAMAGE)], 1_000);
    expect(windows.some(window => window.time_s === 10)).toBe(false);
  });

  it('keeps a dense window exactly at the significance share (strict), dropping one just below', () => {
    const atBoundary = scanWindows(
      [damage(EVISCERATE, 10, SIGNIFICANT_SPIKE), damage(BLACK_POWDER, 500, SIGNIFICANCE_ANCHOR)], 1_000);
    expect(atBoundary.some(window => window.time_s === 10 && window.window_damage === SIGNIFICANT_SPIKE)).toBe(true);
    // One below the boundary spike against the same anchor drops under significancePct, pinning the strict side.
    const belowBoundary = scanWindows(
      [damage(EVISCERATE, 10, SIGNIFICANT_SPIKE - 1), damage(BLACK_POWDER, 500, SIGNIFICANCE_ANCHOR)], 1_000);
    expect(belowBoundary.some(window => window.time_s === 10)).toBe(false);
  });

  it('excludes a hit exactly on the window end (half-open)', () => {
    // Burst 10..13 -> window [10s, 14s); a small probe at exactly 14s is too small to extend the dense run.
    const windows = scanWindows([...burstAt(10), damage(BLACK_POWDER, 14, 10)], LONG_FIGHT_S);
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({ window_length_s: 4, window_damage: 4 * BIN_DAMAGE });
    assert.exists(windows[0]);
    expect(windows[0].ability_breakdown.map(ability => ability.spell_id)).not.toContain(BLACK_POWDER);
  });

  it('includes a hit just inside the window end', () => {
    const probeDamage = 10;
    const windows = scanWindows([...burstAt(10), damage(BLACK_POWDER, 13.999, probeDamage)], LONG_FIGHT_S);
    expect(windows[0]).toMatchObject({ window_length_s: 4, window_damage: 4 * BIN_DAMAGE + probeDamage });
    assert.exists(windows[0]);
    expect(windows[0].ability_breakdown.map(ability => ability.spell_id)).toContain(BLACK_POWDER);
  });

  it('counts a killing-blow hit at exactly fight end in the fight-closing window', () => {
    const KILLING_BLOW_DMG = 5000;
    // LONG_FIGHT_S (300) is an exact BIN_S multiple, so the killing blow at exactly fight end clamps into the last bin.
    const events = [...burstAt(296), damage(EVISCERATE, 300, KILLING_BLOW_DMG)];
    const closing = scanWindows(events, LONG_FIGHT_S).find(window => window.time_s === 296);
    expect(closing?.window_damage).toBe(4 * BIN_DAMAGE + KILLING_BLOW_DMG);
    expect(closing?.ability_breakdown.map(ability => ability.spell_id)).toContain(EVISCERATE);
  });

  it('keeps a last-bin-only window whose only damage is a killing blow at exact fight end', () => {
    const KILLING_BLOW_DMG = 2000;
    // A lone killing blow at exactly fight end forms a last-bin-only window; the fight-closing window counts it.
    const events = [...burstAt(10), damage(EVISCERATE, 300, KILLING_BLOW_DMG)];
    const closing = scanWindows(events, LONG_FIGHT_S).find(window => window.time_s === 299);
    expect(closing?.window_damage).toBe(KILLING_BLOW_DMG);
    expect(closing?.ability_breakdown.map(ability => ability.spell_id)).toContain(EVISCERATE);
  });

  it('attributes a cooldown whose cast lands inside the window', () => {
    // Window is [10s, 14s); a Shadow Blades cast at 10s is inside.
    const timings = cdTimings(timed([cast(SHADOW_BLADES, 10)], 0), [{ name: 'Shadow Blades', spell_id: SHADOW_BLADES, cooldown: 90 }]);
    const windows = scanWindows(burstAt(10), LONG_FIGHT_S, { timings, casts: [cast(SHADOW_BLADES, 10)] });
    assert.exists(windows[0]);
    expect(windows[0].active_cds).toEqual(['Shadow Blades']);
  });

  it('does not attribute a cooldown cast on the half-open window end', () => {
    // A cast at 14s sits exactly on the window end -> not attributed.
    const timings = cdTimings(timed([cast(SHADOW_BLADES, 14)], 0), [{ name: 'Shadow Blades', spell_id: SHADOW_BLADES, cooldown: 90 }]);
    const windows = scanWindows(burstAt(10), LONG_FIGHT_S, { timings, casts: [cast(SHADOW_BLADES, 14)] });
    assert.exists(windows[0]);
    expect(windows[0].active_cds).toEqual([]);
  });

  it('marks an ability with no matching cast event as passive', () => {
    // Eviscerate deals the burst damage but was never cast (only Shadow Blades was).
    const names = new Map([[SHADOW_BLADES, 'Shadow Blades'], [SHADOW_BLADES_DAMAGE, 'Eviscerate']]);
    const windows = scanWindows(burstAt(10), LONG_FIGHT_S, { casts: [cast(SHADOW_BLADES, 10)], abilityNames: names });
    assert.exists(windows[0]);
    expect(windows[0].ability_breakdown[0]).toMatchObject({ spell_id: SHADOW_BLADES_DAMAGE, is_passive: true });
  });

  it('marks an actively cast ability as not passive', () => {
    const names = new Map([[SHADOW_BLADES_DAMAGE, 'Eviscerate']]);
    const windows = scanWindows(burstAt(10), LONG_FIGHT_S, { casts: [cast(SHADOW_BLADES_DAMAGE, 10)], abilityNames: names });
    assert.exists(windows[0]);
    expect(windows[0].ability_breakdown[0]).toMatchObject({ spell_id: SHADOW_BLADES_DAMAGE, is_passive: false });
  });

  it('ranks window abilities by damage and counts casts through the shared ability name', () => {
    const BLACK_POWDER_DMG = 400;
    // Shadow Blades casts as one id and deals damage as another, so only the shared name bridges cast to damage.
    const names = new Map([
      [SHADOW_BLADES, 'Shadow Blades'], [SHADOW_BLADES_DAMAGE, 'Shadow Blades'], [BLACK_POWDER, 'Black Powder'],
    ]);
    const windows = scanWindows([...burstAt(10), damage(BLACK_POWDER, 11, BLACK_POWDER_DMG)], LONG_FIGHT_S,
      { casts: [cast(SHADOW_BLADES, 10)], abilityNames: names });
    assert.exists(windows[0]);
    expect(windows[0].ability_breakdown).toEqual([
      { spell_id: SHADOW_BLADES_DAMAGE, damage: 4 * BIN_DAMAGE, casts: 1, is_passive: false },
      { spell_id: BLACK_POWDER, damage: BLACK_POWDER_DMG, casts: 0, is_passive: true },
    ]);
  });

  it('counts a cast just inside the window end but not one exactly on it', () => {
    const names = new Map([[SHADOW_BLADES, 'Shadow Blades'], [SHADOW_BLADES_DAMAGE, 'Shadow Blades']]);
    // Window is [10s, 14s): the 13.999s cast counts, the 14s cast sits on the half-open end.
    const windows = scanWindows(burstAt(10), LONG_FIGHT_S,
      { casts: [cast(SHADOW_BLADES, 13.999), cast(SHADOW_BLADES, 14)], abilityNames: names });
    assert.exists(windows[0]);
    expect(windows[0].ability_breakdown[0]).toMatchObject({ spell_id: SHADOW_BLADES_DAMAGE, casts: 1 });
  });

  it('caps a window breakdown at the top 6 abilities by damage', () => {
    const TOP_ABILITY_ROWS = 6;
    const ranked = [
      SHADOW_BLADES_DAMAGE, EVISCERATE, BLACK_POWDER, RUPTURE, VANISH, SECRET_TECHNIQUE, SHADOW_DANCE, CLOAK_OF_SHADOWS,
    ];
    const hits = ranked.map((spellId, index) => damage(spellId, 10, (ranked.length - index) * BIN_DAMAGE));
    const windows = scanWindows(hits, LONG_FIGHT_S);
    assert.exists(windows[0]);
    expect(windows[0].ability_breakdown.map(ability => ability.spell_id)).toEqual(ranked.slice(0, TOP_ABILITY_ROWS));
  });

  it('folds distinct synthetic ids that normalize together into one breakdown row', () => {
    const SYNTHETIC_A = -3;
    const SYNTHETIC_B = -7;
    const DMG_A = 600;
    const DMG_B = 400;
    const windows = scanWindows([
      damage(SYNTHETIC_A, 10, DMG_A), damage(SYNTHETIC_B, 10.5, DMG_B), damage(BLACK_POWDER, 50, TOTAL_DAMAGE),
    ], HUNDRED_S_FIGHT_S);
    expect(windows.find(window => window.time_s === 10)?.ability_breakdown).toEqual([
      { spell_id: WCL_SYNTHETIC_SOURCE_FALLBACK_ID, damage: DMG_A + DMG_B, casts: 0, is_passive: true },
    ]);
  });
});

describe('clusterParseWindows', () => {
  const ABILITY_DAMAGE = 600;
  // parse_index defaults to timeS (each window is a distinct parse); pass it explicitly for one parse's several windows.
  const window = (timeS: number, isPassive = false, parseIndex = timeS): ParseWindow => ({
    time_s: timeS, window_length_s: 6, window_damage: BIN_DAMAGE, active_cds: ['Shadow Blades'],
    ability_breakdown: [{ spell_id: SHADOW_BLADES_DAMAGE, damage: ABILITY_DAMAGE, casts: 2, is_passive: isPassive }],
    parse_index: parseIndex,
  });

  it('emits a cluster present in enough parses, with common cds + ability stats', () => {
    // Distinct lengths [4,5,9] (mean 6 only), skewed times [10,11,14] (median 11, not mean 11.7), damages [500,900,700].
    const members: ParseWindow[] = [
      { ...window(10), window_length_s: 4, window_damage: 500 },
      { ...window(11), window_length_s: 5, window_damage: 900 },
      { ...window(14), window_length_s: 9, window_damage: 700 },
    ];
    const out = clusterParseWindows(members, 3);
    expect(out).toHaveLength(1);
    // time_s = median(10,11,14) = 11; window_length_s = mean(4,5,9) = 6; damages: mean 700, min 500, max 900, sample stddev 200.
    expect(out[0]).toMatchObject({
      time_s: 11, common_cds: ['Shadow Blades'], window_length_s: 6,
      dmg_avg: 700, dmg_min: 500, dmg_max: 900, dmg_stddev: 200,
    });
    assert.exists(out[0]);
    expect(out[0].ability_breakdown[0]).toMatchObject({ spell_id: SHADOW_BLADES_DAMAGE, avg_damage: ABILITY_DAMAGE });
  });

  // Consensus gate: survive only with at least max(2, CLUSTER_MIN_FRAC * sampleCount) member parses (floor 4 at sampleCount 10).
  it('keeps a cluster present in enough parses', () => {
    const four = [window(10), window(11), window(12), window(13)];
    expect(clusterParseWindows(four, 10)).toHaveLength(1);
  });

  it('drops a cluster present in fewer parses than the consensus floor', () => {
    const three = [window(10), window(11), window(12)];
    expect(clusterParseWindows(three, 10)).toHaveLength(0);
  });

  it('drops a single-parse cluster even when the sample fraction alone would keep it', () => {
    // sampleCount 2 -> the frac arm is 0.4*2 = 0.8, which 1 member would clear; the absolute max(2, ...) floor drops it.
    expect(clusterParseWindows([window(10)], 2)).toHaveLength(0);
  });

  it('marks a clustered ability passive only when every member never cast it', () => {
    const allPassive = clusterParseWindows([window(10, true), window(11, true)], 2)[0];
    assert.exists(allPassive);
    expect(allPassive.ability_breakdown[0]).toMatchObject({ is_passive: true });
    // One member did cast it -> the clustered ability is not passive.
    const oneCast = clusterParseWindows([window(10, true), window(11, false)], 2)[0];
    assert.exists(oneCast);
    expect(oneCast.ability_breakdown[0]).toMatchObject({ is_passive: false });
  });

  // Consensus counts DISTINCT parses, not windows: two dense runs from one parse count once toward the gate.
  const PARSE_A = 0;
  const PARSE_B = 1;

  it('counts distinct parses, not windows, at the consensus gate', () => {
    // sampleCount 6 -> consensus floor 2.4; the cluster has 3 windows but only 2 distinct parses, so it's dropped.
    const SAMPLE_COUNT = 6;
    const cluster = [window(10, false, PARSE_A), window(11, false, PARSE_A), window(12, false, PARSE_B)];
    expect(clusterParseWindows(cluster, SAMPLE_COUNT)).toHaveLength(0);
  });

  it('keeps each parse\'s biggest window when a parse contributes two to a cluster', () => {
    const SAMPLE_COUNT = 2;
    const PARSE_A_SMALLER_DMG = 500;
    const PARSE_A_BIGGER_DMG = 900;  // PARSE_A's window that survives the dedupe
    const PARSE_B_DMG = 700;
    const EXPECTED_AVG = (PARSE_A_BIGGER_DMG + PARSE_B_DMG) / 2; // PARSE_A's 500 window is dropped
    const small = { ...window(10, false, PARSE_A), window_damage: PARSE_A_SMALLER_DMG };
    const big = { ...window(11, false, PARSE_A), window_damage: PARSE_A_BIGGER_DMG };
    const other = { ...window(12, false, PARSE_B), window_damage: PARSE_B_DMG };
    const out = clusterParseWindows([small, big, other], SAMPLE_COUNT);
    expect(out).toHaveLength(1);
    assert.exists(out[0]);
    expect(out[0].dmg_avg).toBe(EXPECTED_AVG);
  });

  it('gates clustered abilities and cds by a distinct-parse majority (exactly half surfaces, 1 of 4 does not)', () => {
    const SAMPLE_COUNT = 4;
    const main = { spell_id: SHADOW_BLADES_DAMAGE, damage: 500, casts: 1, is_passive: false };
    const half = { spell_id: BLACK_POWDER, damage: 300, casts: 1, is_passive: false };
    const rare = { spell_id: EVISCERATE, damage: 100, casts: 1, is_passive: false };
    const member = (parseIndex: number, abilities: ParseWindow['ability_breakdown'], cds: string[]): ParseWindow =>
      ({ ...window(10 + parseIndex, false, parseIndex), ability_breakdown: abilities, active_cds: cds });
    // MAIN + 'Shadow Blades' in all 4; HALF + 'Vanish' in exactly 2 (2 >= 0.5*4 -> kept); RARE in 1 (0.25 < 0.5 -> dropped).
    const out = clusterParseWindows([
      member(0, [main, half, rare], ['Shadow Blades', 'Vanish']),
      member(1, [main, half], ['Shadow Blades', 'Vanish']),
      member(2, [main], ['Shadow Blades']),
      member(3, [main], ['Shadow Blades']),
    ], SAMPLE_COUNT);
    expect(out).toHaveLength(1);
    assert.exists(out[0]);
    const abilities = out[0].ability_breakdown.map(entry => entry.spell_id);
    expect(abilities).toContain(SHADOW_BLADES_DAMAGE);  // 4 of 4
    expect(abilities).toContain(BLACK_POWDER);          // exactly 2 of 4 -> the >= majority boundary
    expect(abilities).not.toContain(EVISCERATE);        // 1 of 4 -> below majority
    // common_cds share the same majority filter: 'Vanish' at exactly 2 of 4 must also surface.
    assert.exists(out[0]);
    expect(out[0].common_cds).toEqual(expect.arrayContaining(['Shadow Blades', 'Vanish']));
  });
});

const reportAbilities = [{ gameID: SHADOW_BLADES_DAMAGE, name: 'Eviscerate', icon: 'x' }];

// A damage-density burst at 10,11,12s overlaps the Shadow Blades cast at 10s, attributing it inside the measured window.
const burstDamage = [damage(SHADOW_BLADES_DAMAGE, 10, BIN_DAMAGE), damage(SHADOW_BLADES_DAMAGE, 11, BIN_DAMAGE), damage(SHADOW_BLADES_DAMAGE, 12, BIN_DAMAGE)];
const wclFake = {
  // getRankings returns the raw WCL envelope ({ rankings }); the transform unwraps it.
  getRankings: async () => ({ rankings: parseRankings(2) }),
  getReport: reportsByCode({ abilities: reportAbilities }),
  getAllEvents: async (_code: string, _fightId: number, dataType: string) =>
    dataType === 'Casts' ? [cast(SHADOW_BLADES, 10)] : burstDamage,
  getAbilities: abilityLookup(),
};
const filesFake = {
  getRulebook: async () => ok(rulebook({
    spec: 'SubtletyRogue',
    cooldowns: [{ name: 'Shadow Blades', spell_id: SHADOW_BLADES, cooldown: 90 }],
  })),
};

describe('BurstTransformService (live, in-browser)', () => {
  it('computes a clustered burst bench from the top parses', async () => {
    TestBed.configureTestingModule({ providers: provideApiFakes({ wcl: wclFake, files: filesFake }) });
    const bench = await TestBed.inject(BurstTransformService).getBench('SubtletyRogue', 1);
    expect(bench.ok).toBe(true);
    if (!bench.ok) return;
    expect(bench.value.sample_count).toBe(2);
    expect(bench.value.encounter_name).toBe('Boss');
    expect(bench.value.cd_spell_ids).toEqual({ 'Shadow Blades': SHADOW_BLADES });
    expect(bench.value.windows).toHaveLength(1);
    assert.exists(bench.value.windows[0]);
    expect(bench.value.windows[0].common_cds).toContain('Shadow Blades');
    // ability_icons is complete: header cooldown AND every window ability resolved by id.
    expect(bench.value.ability_icons[SHADOW_BLADES]).toEqual({ icon: `icon_${SHADOW_BLADES}`, name: `name_${SHADOW_BLADES}` });
    expect(bench.value.ability_icons[SHADOW_BLADES_DAMAGE]).toEqual({ icon: `icon_${SHADOW_BLADES_DAMAGE}`, name: `name_${SHADOW_BLADES_DAMAGE}` });
  });

  it('returns missing when the spec rulebook has no cooldowns', async () => {
    TestBed.configureTestingModule({
      providers: provideApiFakes({ wcl: wclFake, files: { getRulebook: async () => ok(rulebook({ spec: 'SubtletyRogue', cooldowns: [] })) } }),
    });
    expect(await TestBed.inject(BurstTransformService).getBench('SubtletyRogue', 1))
      .toEqual(missing('Not yet ingested.'));
  });
});
