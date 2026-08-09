import { describe, it, expect } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { WclApiService } from '../../../core/services/wcl-api';
import { DataFileApiService } from '../../../core/services/data-file-api';
import { WclEvent } from '../../../core/models/wcl.models';
import { ok, missing } from '../../../core/result';
import {
  BurstTransformService, cdTimings, findParseWindows, clusterParseWindows, cdSpellIds, ParseWindow,
  bucketDamagePerBin, forwardRollingDamage, detectDenseRuns, trimRunToDamage,
  windowAbilityBreakdown, BinRun,
} from './burst-transform.service';
import { SHADOW_BLADES, SHADOW_BLADES_DAMAGE, EVISCERATE, BLACK_POWDER, CLOAK_OF_SHADOWS } from '../../../../testing/spell-ids';
import { WCL_SYNTHETIC_SOURCE_FALLBACK_ID, withRelativeS } from '../../../shared/analysis/wcl-projections';
import { cast, damage } from '../../../../testing/builders/events';
import { rulebook } from '../../../../testing/builders/rulebook';

/** Fixture events build against a fight-start of 0, so stamping is a pass-through to seconds. */
const timed = withRelativeS;

function scanWindows(
  damageEvents: WclEvent[], fightLenS: number,
  overrides: { timings?: ReturnType<typeof cdTimings>; casts?: WclEvent[]; abilityNames?: Map<number, string> } = {},
): ParseWindow[] {
  return findParseWindows({
    damage: timed(damageEvents, 0), fightLenS,
    timings: overrides.timings ?? [], casts: timed(overrides.casts ?? [], 0), abilityNames: overrides.abilityNames ?? new Map(),
  });
}
function uniformDamage(spellId: number, seconds: number, amount: number): WclEvent[] {
  return Array.from({ length: seconds }, (_, i) => damage(spellId, i, amount));
}

const LONG_FIGHT_S = 300;
const HUNDRED_S_FIGHT_S = 100;
const BIN_DAMAGE = 1000;
// DENSITY_THRESHOLD = THRESHOLD_MULT (1.6) x mean rolling damage on a HUNDRED_S_FIGHT carrying TOTAL_DAMAGE.
const TOTAL_DAMAGE = 1000;
const DENSITY_THRESHOLD = 48;

function burstAt(startS: number): WclEvent[] {
  return [0, 1, 2, 3].map(offset => damage(SHADOW_BLADES_DAMAGE, startS + offset, BIN_DAMAGE));
}

describe('cdSpellIds', () => {
  it('maps cooldown + defensive names to spell ids, skipping missing ids', () => {
    expect(cdSpellIds(
      [{ name: 'Shadow Blades', spell_id: SHADOW_BLADES, cooldown: 90 }, { name: 'NoId', spell_id: 0, cooldown: 60 }],
      [{ name: 'Cloak', spell_id: CLOAK_OF_SHADOWS, cooldown: 120 }],
    )).toEqual({ 'Shadow Blades': SHADOW_BLADES, 'Cloak': CLOAK_OF_SHADOWS });
  });
});

describe('cdTimings', () => {
  it('collects per-cooldown cast times in fight-relative seconds (no duration read)', () => {
    const timings = cdTimings(timed([cast(SHADOW_BLADES, 30), cast(SHADOW_BLADES, 10), cast(999, 5)], 0), [{ name: 'Shadow Blades', spell_id: SHADOW_BLADES, cooldown: 90 }]);
    expect(timings).toEqual([{ name: 'Shadow Blades', castTimesS: [10, 30] }]);
  });
});

describe('bucketDamagePerBin', () => {
  it('sums hits into their fight-relative bin and clamps out-of-range hits', () => {
    const FIRST_HIT = 100;
    const SECOND_HIT = 200;
    const LATE_HIT = 50;
    const BIN_COUNT = 3;
    const hits: [number, number, number][] = [
      [1, FIRST_HIT, EVISCERATE], [1.5, SECOND_HIT, EVISCERATE], [999, LATE_HIT, EVISCERATE],
    ];
    expect(bucketDamagePerBin(hits, BIN_COUNT)).toEqual([0, FIRST_HIT + SECOND_HIT, LATE_HIT]);
  });

  it('clamps a pre-fight hit (negative offset) into bin 0', () => {
    const PRE_FIGHT_HIT = 70;
    expect(bucketDamagePerBin([[-5, PRE_FIGHT_HIT, EVISCERATE]], 2)).toEqual([PRE_FIGHT_HIT, 0]);
  });
});

describe('forwardRollingDamage', () => {
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
    const SB_DMG = 600;
    const BP_DMG = 400;
    // Cast counting must key by NAME: SHADOW_BLADES (cast id) and SHADOW_BLADES_DAMAGE (damage id) share one name.
    const bridgeNameOf = (spellId: number): string =>
      new Map([[SHADOW_BLADES, 'Shadow Blades'], [SHADOW_BLADES_DAMAGE, 'Shadow Blades'], [BLACK_POWDER, 'Black Powder']]).get(spellId) ?? `Spell ${spellId}`;
    // DamageHit = [atS, dmg, abilityId]; window is [1s, 3s).
    const windowHits: [number, number, number][] = [[1, SB_DMG, SHADOW_BLADES_DAMAGE], [1.5, BP_DMG, BLACK_POWDER]];
    // CastRow = [atS, abilityId]; the Shadow Blades cast carries the CAST id, distinct from the damage id.
    const castRows: [number, number][] = [[1.2, SHADOW_BLADES], [9, BLACK_POWDER]];
    const castNamesInParse = new Set(['Shadow Blades']);
    const breakdown = windowAbilityBreakdown(windowHits, castRows, 1, 3, bridgeNameOf, castNamesInParse);
    expect(breakdown).toEqual([
      { spell_id: SHADOW_BLADES_DAMAGE, damage: SB_DMG, casts: 1, is_passive: false },
      // Black Powder was never cast in the parse -> passive, and 0 in-window casts.
      { spell_id: BLACK_POWDER, damage: BP_DMG, casts: 0, is_passive: true },
    ]);
  });

  it('excludes a cast exactly on the half-open window end', () => {
    const HIT_DMG = 500;
    const windowHits: [number, number, number][] = [[1, HIT_DMG, EVISCERATE]];
    // A cast at exactly endS (3) is excluded; one just inside (2.999) counts.
    const castRows: [number, number][] = [[3, EVISCERATE], [2.999, EVISCERATE]];
    const breakdown = windowAbilityBreakdown(windowHits, castRows, 1, 3, nameOf, new Set(['Eviscerate']));
    expect(breakdown[0].casts).toBe(1);
  });

  it('caps the breakdown at the top 6 abilities by damage', () => {
    const ABILITY_COUNT = 8;
    // Eight abilities, descending damage; only the top 6 survive.
    const windowHits: [number, number, number][] = Array.from(
      { length: ABILITY_COUNT }, (_, index) => [1, (ABILITY_COUNT - index) * 100, index + 1] as [number, number, number],
    );
    const breakdown = windowAbilityBreakdown(windowHits, [], 1, 3, nameOf, new Set());
    expect(breakdown).toHaveLength(6);
    expect(breakdown[0].damage).toBe(ABILITY_COUNT * 100);
  });

  it('folds distinct synthetic ids that normalize together into one summed row', () => {
    const SYNTH_A = -3, SYNTH_B = -7;  // distinct negatives, both normalize to the synthetic catch-all
    const DMG_A = 600, DMG_B = 400;
    const windowHits: [number, number, number][] = [[1, DMG_A, SYNTH_A], [1.5, DMG_B, SYNTH_B]];
    expect(windowAbilityBreakdown(windowHits, [], 1, 3, nameOf, new Set())).toEqual([
      { spell_id: WCL_SYNTHETIC_SOURCE_FALLBACK_ID, damage: DMG_A + DMG_B, casts: 0, is_passive: true },
    ]);
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

  it('drops a dense window below the significance share of fight damage', () => {
    // Spike of BIN_DAMAGE beside a 100x anchor: BIN_DAMAGE / (101 * BIN_DAMAGE) < SIGNIFICANCE_PCT -> dropped.
    const windows = scanWindows([damage(EVISCERATE, 10, BIN_DAMAGE), damage(BLACK_POWDER, 500, 100 * BIN_DAMAGE)], 1_000);
    expect(windows.some(window => window.time_s === 10)).toBe(false);
  });

  it('keeps a dense window exactly at the significance share (strict), dropping one just below', () => {
    // Spike beside a 9850 anchor on a 1000-bin fight. 150 / 10000 = 1.5% = SIGNIFICANCE_PCT exactly -> kept (strict <).
    const atBoundary = scanWindows([damage(EVISCERATE, 10, 150), damage(BLACK_POWDER, 500, 9850)], 1_000);
    expect(atBoundary.some(window => window.time_s === 10 && window.window_damage === 150)).toBe(true);
    // 149 / 9999 = 1.49% < 1.5% -> dropped, so the strict boundary is pinned on both sides.
    const belowBoundary = scanWindows([damage(EVISCERATE, 10, 149), damage(BLACK_POWDER, 500, 9850)], 1_000);
    expect(belowBoundary.some(window => window.time_s === 10)).toBe(false);
  });

  it('excludes a hit exactly on the window end (half-open)', () => {
    // Burst 10..13 -> window [10s, 14s); a small probe at exactly 14s is too small to extend the dense run.
    const windows = scanWindows([...burstAt(10), damage(BLACK_POWDER, 14, 10)], LONG_FIGHT_S);
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({ window_length_s: 4, window_damage: 4 * BIN_DAMAGE });
    expect(windows[0].ability_breakdown.map(ability => ability.spell_id)).not.toContain(BLACK_POWDER);
  });

  it('includes a hit just inside the window end', () => {
    const probeDamage = 10;
    const windows = scanWindows([...burstAt(10), damage(BLACK_POWDER, 13.999, probeDamage)], LONG_FIGHT_S);
    expect(windows[0]).toMatchObject({ window_length_s: 4, window_damage: 4 * BIN_DAMAGE + probeDamage });
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
    expect(windows[0].active_cds).toEqual(['Shadow Blades']);
  });

  it('does not attribute a cooldown cast on the half-open window end', () => {
    // A cast at 14s sits exactly on the window end -> not attributed.
    const timings = cdTimings(timed([cast(SHADOW_BLADES, 14)], 0), [{ name: 'Shadow Blades', spell_id: SHADOW_BLADES, cooldown: 90 }]);
    const windows = scanWindows(burstAt(10), LONG_FIGHT_S, { timings, casts: [cast(SHADOW_BLADES, 14)] });
    expect(windows[0].active_cds).toEqual([]);
  });

  it('marks an ability with no matching cast event as passive', () => {
    // Eviscerate deals the burst damage but was never cast (only Shadow Blades was).
    const names = new Map([[SHADOW_BLADES, 'Shadow Blades'], [SHADOW_BLADES_DAMAGE, 'Eviscerate']]);
    const windows = scanWindows(burstAt(10), LONG_FIGHT_S, { casts: [cast(SHADOW_BLADES, 10)], abilityNames: names });
    expect(windows[0].ability_breakdown[0]).toMatchObject({ spell_id: SHADOW_BLADES_DAMAGE, is_passive: true });
  });

  it('marks an actively cast ability as not passive', () => {
    const names = new Map([[SHADOW_BLADES_DAMAGE, 'Eviscerate']]);
    const windows = scanWindows(burstAt(10), LONG_FIGHT_S, { casts: [cast(SHADOW_BLADES_DAMAGE, 10)], abilityNames: names });
    expect(windows[0].ability_breakdown[0]).toMatchObject({ spell_id: SHADOW_BLADES_DAMAGE, is_passive: false });
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
    expect(out[0].ability_breakdown[0]).toMatchObject({ spell_id: SHADOW_BLADES_DAMAGE, avg_damage: ABILITY_DAMAGE, count: 3 });
  });

  it('does not emit avg_targets', () => {
    expect(clusterParseWindows([window(10), window(11)], 2)[0]).not.toHaveProperty('avg_targets');
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
    expect(clusterParseWindows([window(10, true), window(11, true)], 2)[0].ability_breakdown[0])
      .toMatchObject({ is_passive: true });
    // One member did cast it -> the clustered ability is not passive.
    expect(clusterParseWindows([window(10, true), window(11, false)], 2)[0].ability_breakdown[0])
      .toMatchObject({ is_passive: false });
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
    const abilities = out[0].ability_breakdown.map(entry => entry.spell_id);
    expect(abilities).toContain(SHADOW_BLADES_DAMAGE);  // 4 of 4
    expect(abilities).toContain(BLACK_POWDER);          // exactly 2 of 4 -> the >= majority boundary
    expect(abilities).not.toContain(EVISCERATE);        // 1 of 4 -> below majority
    expect(out[0].ability_breakdown.find(entry => entry.spell_id === BLACK_POWDER)?.count).toBe(2);  // count = distinct parses
    // common_cds share the same majority filter: 'Vanish' at exactly 2 of 4 must also surface.
    expect(out[0].common_cds).toEqual(expect.arrayContaining(['Shadow Blades', 'Vanish']));
  });
});

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

// A damage-density burst at 10,11,12s overlaps the Shadow Blades cast at 10s, attributing it inside the measured window.
const burstDamage = [damage(SHADOW_BLADES_DAMAGE, 10, BIN_DAMAGE), damage(SHADOW_BLADES_DAMAGE, 11, BIN_DAMAGE), damage(SHADOW_BLADES_DAMAGE, 12, BIN_DAMAGE)];
const wclFake = {
  // getRankings returns the raw WCL envelope ({ rankings }); the transform unwraps it.
  getRankings: async () => ({
    rankings: [
      { name: 'P1', report: { code: 'r1', fightID: 1 } },
      { name: 'P2', report: { code: 'r2', fightID: 2 } },
    ],
  }),
  getReport: async (code: string) => (code === 'r1' ? reportFor(10, 'P1', 1) : reportFor(20, 'P2', 2)),
  getAllEvents: async (_code: string, _fightId: number, dataType: string) =>
    dataType === 'Casts' ? [cast(SHADOW_BLADES, 10)] : burstDamage,
  // Raw gameData.ability map (id-keyed { id, icon, name }); the transform projects it.
  getAbilities: async (ids: number[]) =>
    Object.fromEntries(ids.map(id => [id, { id, icon: `icon_${id}`, name: `name_${id}` }])),
};
const filesFake = {
  getRulebook: async () => ok(rulebook({
    spec: 'SubtletyRogue',
    cooldowns: [{ name: 'Shadow Blades', spell_id: SHADOW_BLADES, cooldown: 90, duration: 20 }],
  })),
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
    expect(bench.ok).toBe(true);
    if (!bench.ok) return;
    expect(bench.value.sample_count).toBe(2);
    expect(bench.value.encounter_name).toBe('Boss');
    expect(bench.value.cd_spell_ids).toEqual({ 'Shadow Blades': SHADOW_BLADES });
    expect(bench.value.windows).toHaveLength(1);
    expect(bench.value.windows[0].common_cds).toContain('Shadow Blades');
    // ability_icons is complete: header cooldown AND every window ability resolved by id.
    expect(bench.value.ability_icons[SHADOW_BLADES]).toEqual({ icon: `icon_${SHADOW_BLADES}`, name: `name_${SHADOW_BLADES}` });
    expect(bench.value.ability_icons[SHADOW_BLADES_DAMAGE]).toEqual({ icon: `icon_${SHADOW_BLADES_DAMAGE}`, name: `name_${SHADOW_BLADES_DAMAGE}` });
  });

  it('backfills past a private (unfetchable) top parse to keep the sample count full', async () => {
    const candidates = Array.from({ length: 11 }, (_, i) => ({ name: `P${i + 1}`, report: { code: `r${i + 1}`, fightID: i + 1 } }));
    const backfillWcl = {
      ...wclFake,
      getRankings: async () => ({ rankings: candidates }),
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
    expect(bench.ok).toBe(true);
    // 11 candidates, one private: the 11th backfills the skipped parse to a full 10.
    if (bench.ok) expect(bench.value.sample_count).toBe(10);
  });

  it('returns missing when the spec rulebook has no cooldowns', async () => {
    TestBed.configureTestingModule({
      providers: [
        { provide: WclApiService, useValue: wclFake as unknown as WclApiService },
        {
          provide: DataFileApiService,
          useValue: { getRulebook: async () => ok(rulebook({ spec: 'SubtletyRogue', cooldowns: [] })) } as unknown as DataFileApiService,
        },
      ],
    });
    expect(await TestBed.inject(BurstTransformService).getBench('SubtletyRogue', 1))
      .toEqual(missing('Not yet ingested.'));
  });

  it('propagates a missing rulebook read as missing', async () => {
    TestBed.configureTestingModule({
      providers: [
        { provide: WclApiService, useValue: wclFake as unknown as WclApiService },
        {
          provide: DataFileApiService,
          useValue: { getRulebook: async () => missing('Not yet ingested.') } as unknown as DataFileApiService,
        },
      ],
    });
    expect(await TestBed.inject(BurstTransformService).getBench('SubtletyRogue', 1))
      .toEqual(missing('Not yet ingested.'));
  });
});
