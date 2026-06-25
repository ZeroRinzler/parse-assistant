import { describe, it, expect } from 'vitest';
import {
  benchUsesPerMin, buildHoldTargets, buildBaseBenchmark,
  computeEfficiencyThresholds, aggregateCooldownBenchmarks, aggregateDefensiveBenchmarks, buildEncounterBench,
} from './bench.ts';
import { sample } from '../testing/samples.ts';
import { SHADOW_BLADES, CLOAK_OF_SHADOWS } from '../testing/spell-ids.ts';
import type { BenchEntry } from '../models/bench.models.ts';
import type { CdCastSummary, DefensiveCastSummary } from '../models/parse-sample.models.ts';
import type { RulebookDefensive } from '../../../src/app/core/models/rulebook.models.ts';

function cdEntry(over: Partial<CdCastSummary> = {}): CdCastSummary {
  return {
    name: 'Shadow Blades', spell_id: SHADOW_BLADES, total_uses: 1, first_cast_s: 5,
    bl_aligned: false, bl_offset_s: null, cast_times_s: [5], hold_windows: [], cast_pattern: 'on_cooldown', ...over,
  };
}

describe('benchUsesPerMin', () => {
  it('returns {} when no entry has both duration and casts', () => {
    expect(benchUsesPerMin([{ first_cast_s: null, cast_times_s: [], fight_duration_s: 0, hold_windows: [], cast_pattern: 'on_cooldown' }])).toEqual({});
  });

  it('computes avg/stddev/min/max uses-per-minute', () => {
    const entries: BenchEntry[] = [
      { first_cast_s: 5, cast_times_s: [5, 65], fight_duration_s: 60, hold_windows: [], cast_pattern: 'on_cooldown' },
      { first_cast_s: 7, cast_times_s: [7], fight_duration_s: 60, hold_windows: [], cast_pattern: 'on_cooldown' },
    ];
    expect(benchUsesPerMin(entries)).toEqual({ avg: 1.5, stddev: 0.707, min: 1, max: 2 });
  });
});

describe('buildHoldTargets', () => {
  it('emits a hold target only where enough parsers held, using the median delay', () => {
    const held = (actualS: number): BenchEntry => ({
      first_cast_s: 0, cast_times_s: [], fight_duration_s: 300, cast_pattern: 'hold',
      hold_windows: [{ cast_index: 2, expected_s: 100, actual_s: actualS, hold_amount_s: actualS - 100 }],
    });
    const noHold: BenchEntry = { first_cast_s: 0, cast_times_s: [], fight_duration_s: 300, hold_windows: [], cast_pattern: 'on_cooldown' };
    // 5 entries, 3 held at index 2 (>= max(2, 5*0.4=2)).
    const targets = buildHoldTargets([held(120), held(130), held(140), noHold, noHold]);
    expect(targets['2']).toEqual({ target_s: 130, stddev_s: 10, count: 3, total_samples: 5 });
  });
});

describe('buildBaseBenchmark', () => {
  it('aggregates first-cast, gaps, uses and majority-hold', () => {
    const entries = [
      { first_cast_s: 5, cast_times_s: [5, 65], fight_duration_s: 60, hold_windows: [], cast_pattern: 'on_cooldown', total_uses: 2 },
      { first_cast_s: 7, cast_times_s: [7], fight_duration_s: 60, hold_windows: [], cast_pattern: 'on_cooldown', total_uses: 1 },
    ];
    const bench = buildBaseBenchmark(entries, entry => (entry as unknown as { total_uses: number }).total_uses, false);
    expect(bench.avg_first_cast_s).toBe(6);
    expect(bench.stddev_first_cast_s).toBe(1.4);
    expect(bench.avg_gap_s).toBe(60); // only entry 1 contributes a gap
    expect(bench.avg_uses).toBe(1.5);
    expect(bench.majority_hold).toBe(false);
  });

  it('leaves avg_gap_s null when no entry has >= 2 casts', () => {
    const entries = [{ first_cast_s: 5, cast_times_s: [5], fight_duration_s: 60, hold_windows: [], cast_pattern: 'on_cooldown', uses: 1 }];
    const bench = buildBaseBenchmark(entries, entry => (entry as unknown as { uses: number }).uses, true);
    expect(bench.avg_gap_s).toBeNull();
    expect(bench.stddev_gap_s).toBeNull();
  });
});

describe('computeEfficiencyThresholds', () => {
  it('derives the p90 downtime threshold and the efficiency mean', () => {
    const gaps = [1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 5000];
    const result = computeEfficiencyThresholds([sample({ cast_gap_list_ms: gaps, fight_duration_s: 100 })]);
    expect(result.downtimeThresholdMs).toBe(1000); // p90 of the pooled gaps
    // only the 5000ms gap exceeds 1000 -> 5s downtime over 100s -> 95%
    expect(result.topAvgEfficiency).toBe(95);
  });
});

describe('aggregateCooldownBenchmarks', () => {
  it('adds BL offset/pct alongside the base benchmark', () => {
    const samples = [
      sample({ cooldowns: [cdEntry({ bl_aligned: true, bl_offset_s: 5 })] }),
      sample({ cooldowns: [cdEntry({ bl_aligned: true, bl_offset_s: 7 })] }),
    ];
    const benchmarks = aggregateCooldownBenchmarks(samples);
    expect(benchmarks['Shadow Blades'].avg_bl_offset_s).toBe(6);
    expect(benchmarks['Shadow Blades'].bl_pct).toBe(100);
  });
});

describe('aggregateDefensiveBenchmarks', () => {
  it('summarizes uses for rulebook defensives that appear in samples', () => {
    const defensive: DefensiveCastSummary = {
      name: 'Cloak of Shadows', spell_id: CLOAK_OF_SHADOWS, cooldown: 120, uses: 2,
      cast_times_s: [10, 140], first_cast_s: 10, hold_windows: [], cast_pattern: 'on_cooldown', windows: [],
    };
    const specDefensives: RulebookDefensive[] = [{ name: 'Cloak of Shadows', spell_id: CLOAK_OF_SHADOWS, cooldown: 120, duration: 5 }];
    const { topDefensivesSummary, perDefensiveBenchmarks } = aggregateDefensiveBenchmarks(
      [sample({ defensives: [defensive] }), sample({ defensives: [{ ...defensive, uses: 1, cast_times_s: [10] }] })],
      specDefensives,
    );
    expect(topDefensivesSummary[0]).toMatchObject({ name: 'Cloak of Shadows', avg_uses: 1.5, min_uses: 1, max_uses: 2, sample_count: 2 });
    expect(perDefensiveBenchmarks['Cloak of Shadows'].sample_count).toBe(2);
  });
});

describe('buildEncounterBench', () => {
  it('assembles the full bench envelope from samples', () => {
    const samples = [
      sample({ cooldowns: [cdEntry()], cast_gap_list_ms: [1000, 2000], talent_key: 'A' }),
      sample({ cooldowns: [cdEntry()], cast_gap_list_ms: [1000, 3000], talent_key: 'A' }),
    ];
    const bench = buildEncounterBench(samples, [], 'SubtletyRogue', 1000);
    expect(bench).toMatchObject({ spec: 'SubtletyRogue', encounter_id: 1000, encounter_name: 'Test Boss', sample_count: 2 });
    expect(Object.keys(bench.per_cd_benchmarks)).toContain('Shadow Blades');
    expect(bench.gear.sample_count).toBe(2);
    expect(bench.avg_duration_s).toBe(300);
  });
});
