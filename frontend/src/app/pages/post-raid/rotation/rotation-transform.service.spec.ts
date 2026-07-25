import { describe, it, expect } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { WclApiService } from '../../../core/services/wcl-api';
import { DataFileApiService } from '../../../core/services/data-file-api';
import {
  RotationTransformService,
  detectBloodlust, summarizeCooldownCasts, castGapListMs,
  buildCdBenchmark, computeEfficiencyThresholds, aggregateCdBenchmarks, rotationCdSpellIds,
  CdSummary,
} from './rotation-transform.service';
import { SHADOW_BLADES, BLOODLUST, CLOAK_OF_SHADOWS } from '../../../../testing/spell-ids';
import { cast, applyBuff } from '../../../../testing/builders/events';
import { rulebook } from '../../../../testing/builders/rulebook';
import { ok, missing } from '../../../core/result';

describe('rotationCdSpellIds', () => {
  it('maps cooldown + defensive names to spell ids, skipping missing ids', () => {
    expect(rotationCdSpellIds(
      [{ name: 'Shadow Blades', spell_id: SHADOW_BLADES, cooldown: 90 }, { name: 'NoId', spell_id: 0, cooldown: 60 }],
      [{ name: 'Cloak', spell_id: CLOAK_OF_SHADOWS, cooldown: 120 }],
    )).toEqual({ 'Shadow Blades': SHADOW_BLADES, 'Cloak': CLOAK_OF_SHADOWS });
  });
});

describe('detectBloodlust', () => {
  it('returns the first BL apply time in seconds', () => {
    expect(detectBloodlust([applyBuff(999, 5), applyBuff(BLOODLUST, 30)], 0)).toBe(30);
  });
  it('returns null when no BL buff present', () => {
    expect(detectBloodlust([applyBuff(999, 5)], 0)).toBeNull();
  });
});

describe('summarizeCooldownCasts', () => {
  const cooldowns = [{ name: 'Shadow Blades', spell_id: SHADOW_BLADES, cooldown: 90 }];

  it('counts casts, first cast, BL alignment and offset', () => {
    const summaries = summarizeCooldownCasts([cast(SHADOW_BLADES, 32)], cooldowns, 0, 200, 30);
    expect(summaries[0]).toMatchObject({ name: 'Shadow Blades', total_uses: 1, first_cast_s: 32, bl_aligned: true, bl_offset_s: 2 });
  });

  it('flags a held second cast (>8s past the prior cast + cooldown)', () => {
    const summaries = summarizeCooldownCasts([cast(SHADOW_BLADES, 0), cast(SHADOW_BLADES, 110)], cooldowns, 0, 200, null);
    expect(summaries[0].cast_pattern).toBe('hold');
    // prior 0 + cd 90 = expected 90; actual 110 -> 20s hold.
    expect(summaries[0].hold_windows[0]).toMatchObject({ cast_index: 2, actual_s: 110, delay_s: 20 });
  });

  it('measures each hold from the prior cast, so one hold does not cascade', () => {
    // cast 2 held (0 -> 200, well past reset); cast 3 is on cooldown after it (200 -> 290).
    const summaries = summarizeCooldownCasts(
      [cast(SHADOW_BLADES, 0), cast(SHADOW_BLADES, 200), cast(SHADOW_BLADES, 290)], cooldowns, 0, 400, null);
    expect(summaries[0].hold_windows).toHaveLength(1);
    expect(summaries[0].hold_windows[0].cast_index).toBe(2);
  });

  it('does not flag a hold exactly at the threshold (strict)', () => {
    // prior 0 + cd 90 + 8s threshold = 98; a cast at 98 has delay exactly 8 -> not a hold.
    const atBoundary = summarizeCooldownCasts([cast(SHADOW_BLADES, 0), cast(SHADOW_BLADES, 98)], cooldowns, 0, 200, null);
    expect(atBoundary[0].hold_windows).toHaveLength(0);
    const past = summarizeCooldownCasts([cast(SHADOW_BLADES, 0), cast(SHADOW_BLADES, 98.1)], cooldowns, 0, 200, null);
    expect(past[0].hold_windows).toHaveLength(1);
  });
});

describe('castGapListMs', () => {
  it('returns sorted inter-cast gaps in ms', () => {
    expect(castGapListMs([cast(1, 0), cast(1, 3), cast(1, 1)])).toEqual([1000, 2000]);
  });
});

describe('buildCdBenchmark', () => {
  const entry = (firstCast: number, uses: number, dur: number, blOffset: number | null, blAligned: boolean, times: number[]): CdSummary => ({
    name: 'Shadow Blades', total_uses: uses, first_cast_s: firstCast, bl_aligned: blAligned, bl_offset_s: blOffset,
    cast_times_s: times, hold_windows: [], cast_pattern: 'on_cooldown', fight_duration_s: dur,
  });
  const withHolders = (holding: number, total: number): CdSummary[] => [
    ...Array.from({ length: holding }, () => ({ ...entry(0, 1, 200, null, false, [0]), cast_pattern: 'hold' as const })),
    ...Array.from({ length: total - holding }, () => entry(0, 1, 200, null, false, [0])),
  ];

  it('rolls first cast, gaps, BL offset and uses/min across parses', () => {
    const bench = buildCdBenchmark([
      entry(5, 2, 120, 2, true, [5, 95]),
      entry(7, 2, 120, 4, true, [7, 97]),
    ], 90);
    expect(bench.sample_count).toBe(2);
    expect(bench.used_sample_count).toBe(2);
    expect(bench.avg_first_cast_s).toBe(6);
    expect(bench.avg_bl_offset_s).toBe(3);
    expect(bench.bl_pct).toBe(100);
    expect(bench.avg_uses).toBe(2);
    // 2 casts over a 120s fight -> 1.0 uses/min for both parses.
    expect(bench.uses_per_min.avg).toBe(1);
    // inter-cast gaps [95-5, 97-7] = [90, 90] -> mean 90, stddev 0.
    expect(bench.avg_gap_s).toBe(90);
    expect(bench.stddev_gap_s).toBe(0);
  });

  it('counts used_sample_count as the parses with at least one use (use-share gate)', () => {
    const TOTAL_PARSES = 2;
    const USERS = 1;  // one parse used it, one never did
    const usedParse = entry(5, 2, 120, 2, true, [5, 95]);
    const unusedParse: CdSummary = {
      name: 'Shadow Blades', total_uses: 0, first_cast_s: null, bl_aligned: false, bl_offset_s: null,
      cast_times_s: [], hold_windows: [], cast_pattern: 'on_cooldown', fight_duration_s: 120,
    };
    const bench = buildCdBenchmark([usedParse, unusedParse], 90);
    expect(bench.sample_count).toBe(TOTAL_PARSES);
    expect(bench.used_sample_count).toBe(USERS);
  });

  it('leaves gap + BL fields null when not applicable', () => {
    const bench = buildCdBenchmark([entry(5, 1, 120, null, false, [5])], 90);
    expect(bench.avg_gap_s).toBeNull();
    expect(bench.avg_bl_offset_s).toBeNull();
    expect(bench.bl_pct).toBe(0);
  });

  it('sets majority_hold at an exact consensus tie, aligning it with hold_targets', () => {
    const TOTAL_PARSES = 10;
    const HOLDERS_AT_TIE = 5;  // exactly HOLD_CONSENSUS_FRAC of 10 -> the consensus boundary is inclusive
    expect(buildCdBenchmark(withHolders(HOLDERS_AT_TIE, TOTAL_PARSES), 90).majority_hold).toBe(true);
  });

  it('clears majority_hold when fewer than the consensus fraction hold', () => {
    const TOTAL_PARSES = 10;
    const HOLDERS_BELOW = 4;  // below HOLD_CONSENSUS_FRAC of 10
    expect(buildCdBenchmark(withHolders(HOLDERS_BELOW, TOTAL_PARSES), 90).majority_hold).toBe(false);
  });
});

describe('computeEfficiencyThresholds', () => {
  it('derives a p90 downtime floor and per-parse efficiency mean', () => {
    const result = computeEfficiencyThresholds([[500, 600, 700, 5000]], [100]);
    // d3 p90 quantile of [500,600,700,5000]: 700 + 0.7*(5000-700) = 3710 ms.
    expect(result.downtimeThresholdMs).toBe(3710);
    // only the 5000ms gap clears the floor -> 5s downtime over 100s -> (1 - 5/100)*100 = 95%.
    expect(result.topAvgEfficiency).toBe(95);
  });

  it('falls back to the default floor with no gaps', () => {
    const result = computeEfficiencyThresholds([[]], [100]);
    expect(result.downtimeThresholdMs).toBe(1500);
    expect(result.topAvgEfficiency).toBe(0);
  });
});

describe('aggregateCdBenchmarks', () => {
  it('groups per-parse summaries by cooldown name', () => {
    const summary = (name: string): CdSummary => ({
      name, total_uses: 1, first_cast_s: 5, bl_aligned: false, bl_offset_s: null,
      cast_times_s: [5], hold_windows: [], cast_pattern: 'on_cooldown', fight_duration_s: 120,
    });
    const result = aggregateCdBenchmarks(
      [[summary('Shadow Blades')], [summary('Shadow Blades')]],
      [{ name: 'Shadow Blades', spell_id: SHADOW_BLADES, cooldown: 90 }]);
    expect(Object.keys(result)).toEqual(['Shadow Blades']);
    expect(result['Shadow Blades'].sample_count).toBe(2);
  });
});

function reportFor(playerId: number, playerName: string, fightId: number) {
  return {
    title: 't',
    fights: [{ id: fightId, name: 'Boss', startTime: 0, endTime: 120_000 }],
    masterData: {
      actors: [{ id: playerId, name: playerName, subType: 'Rogue', server: '' }],
      abilities: [{ gameID: SHADOW_BLADES, name: 'Shadow Blades', icon: 'sb' }],
    },
  };
}

// An id outside the rulebook cooldowns; exercises the cooldown-cast filter.
const UNTRACKED_SPELL_ID = 99;

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
    dataType === 'Casts' ? [cast(SHADOW_BLADES, 5), cast(UNTRACKED_SPELL_ID, 8)] : [applyBuff(BLOODLUST, 6)],
  // Raw gameData.ability map (id-keyed { id, icon, name }); the transform projects it.
  getAbilities: async (ids: number[]) =>
    Object.fromEntries(ids.map(id => [id, { id, icon: 'sb', name: 'Shadow Blades' }])),
};
const filesFake = {
  getRulebook: async () => ok(rulebook({
    cooldowns: [{ name: 'Shadow Blades', spell_id: SHADOW_BLADES, cooldown: 90, align_with_bloodlust: true }],
  })),
};

describe('RotationTransformService (live, in-browser)', () => {
  // Full sample size the transform caps at (TOP_PARSE_COUNT in the service).
  const FULL_SAMPLE_COUNT = 10;
  // One private candidate over-fetched past, plus the full sample: 11 candidates in.
  const CANDIDATE_COUNT = FULL_SAMPLE_COUNT + 1;
  const PRIVATE_CODE = 'r5';

  it('computes a rotation bench from the top parses', async () => {
    TestBed.configureTestingModule({
      providers: [
        { provide: WclApiService, useValue: wclFake as unknown as WclApiService },
        { provide: DataFileApiService, useValue: filesFake as unknown as DataFileApiService },
      ],
    });
    const result = await TestBed.inject(RotationTransformService).getBench('SubtletyRogue', 1);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const bench = result.value;
      expect(bench.sample_count).toBe(2);
      expect(bench.encounter_name).toBe('Boss');
      expect(bench.cd_spell_ids).toEqual({ 'Shadow Blades': SHADOW_BLADES });
      expect(bench.per_cd_benchmarks['Shadow Blades'].sample_count).toBe(2);
      expect(bench.ability_icons[SHADOW_BLADES]).toEqual({ icon: 'sb', name: 'Shadow Blades' });
      expect(bench.major_cooldowns).toHaveLength(1);
    }
  });

  it('backfills past a private (unfetchable) top parse to keep the sample count full', async () => {
    const candidates = Array.from({ length: CANDIDATE_COUNT }, (_, i) => ({ name: `P${i + 1}`, report: { code: `r${i + 1}`, fightID: i + 1 } }));
    const backfillWcl = {
      ...wclFake,
      getRankings: async () => ({ rankings: candidates }),
      getReport: async (code: string) => {
        if (code === PRIVATE_CODE) throw new Error('You do not have permission to view this report.');
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
    const result = await TestBed.inject(RotationTransformService).getBench('SubtletyRogue', 1);
    expect(result.ok).toBe(true);
    // 11 candidates, one private: the 11th backfills the skipped parse to a full 10.
    if (result.ok) expect(result.value.sample_count).toBe(FULL_SAMPLE_COUNT);
  });

  it('propagates a missing error when the spec has no rulebook cooldowns', async () => {
    TestBed.configureTestingModule({
      providers: [
        { provide: WclApiService, useValue: wclFake as unknown as WclApiService },
        // A rulebook with no cooldowns is nothing to analyze - the transform reports missing.
        { provide: DataFileApiService, useValue: { getRulebook: async () => ok(rulebook()) } as unknown as DataFileApiService },
      ],
    });
    expect(await TestBed.inject(RotationTransformService).getBench('SubtletyRogue', 1))
      .toEqual(missing('No rulebook cooldowns for this spec.'));
  });
});
