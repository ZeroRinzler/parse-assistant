import { describe, it, expect } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { WclApiService } from '../../../core/services/wcl-api';
import { DataFileApiService } from '../../../core/services/data-file-api';
import { WclEvent } from '../../../core/models/wcl.models';
import {
  RotationTransformService,
  detectBloodlust, summarizeCooldownCasts, detectHoldWindows, castGapListMs,
  buildCdBenchmark, buildHoldTargets, computeEfficiencyThresholds, aggregateCdBenchmarks, rotationCdSpellIds,
  CdSummary,
} from './rotation-transform.service';
import { SHADOW_BLADES, BLOODLUST, CLOAK_OF_SHADOWS } from '../../../../testing/spell-ids';

function cast(spellId: number, atS: number): WclEvent {
  return { type: 'cast', timestamp: atS * 1000, abilityGameID: spellId };
}
function buff(spellId: number, atS: number): WclEvent {
  return { type: 'applybuff', timestamp: atS * 1000, abilityGameID: spellId };
}

/* ----------------------------- pure functions ----------------------------- */

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
    expect(detectBloodlust([buff(999, 5), buff(BLOODLUST, 30)], 0)).toBe(30);
  });
  it('returns null when no BL buff present', () => {
    expect(detectBloodlust([buff(999, 5)], 0)).toBeNull();
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

describe('detectHoldWindows', () => {
  const EFFECTIVE_CD_S = 90;

  it('flags a cast more than 8s past the prior cast + cooldown', () => {
    // prior 0 + cd 90 = expected 90; actual 110 -> 20s hold.
    const holds = detectHoldWindows([0, 110], EFFECTIVE_CD_S);
    expect(holds).toHaveLength(1);
    expect(holds[0]).toMatchObject({ cast_index: 2, actual_s: 110, delay_s: 20 });
  });

  it('does not flag a cast exactly at the threshold (strict)', () => {
    // prior 0 + cd 90 + 8s threshold = 98; delay exactly 8 -> not a hold.
    expect(detectHoldWindows([0, 98], EFFECTIVE_CD_S)).toHaveLength(0);
    expect(detectHoldWindows([0, 98.1], EFFECTIVE_CD_S)).toHaveLength(1);
  });

  it('measures each hold from the prior cast, so one hold does not cascade', () => {
    // cast 2 held (0 -> 200); cast 3 on cooldown after it (200 -> 290).
    const holds = detectHoldWindows([0, 200, 290], EFFECTIVE_CD_S);
    expect(holds).toHaveLength(1);
    expect(holds[0].cast_index).toBe(2);
  });

  it('returns nothing with a single cast', () => {
    expect(detectHoldWindows([5], EFFECTIVE_CD_S)).toEqual([]);
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

  it('rolls first cast, gaps, BL offset and uses/min across parses', () => {
    const bench = buildCdBenchmark([
      entry(5, 2, 120, 2, true, [5, 95]),
      entry(7, 2, 120, 4, true, [7, 97]),
    ], 90);
    expect(bench.sample_count).toBe(2);
    expect(bench.avg_first_cast_s).toBe(6);
    expect(bench.avg_bl_offset_s).toBe(3);
    expect(bench.bl_pct).toBe(100);
    expect(bench.avg_uses).toBe(2);
    expect(bench.uses_per_min.avg).toBeGreaterThan(0);
  });

  it('leaves gap + BL fields null when not applicable', () => {
    const bench = buildCdBenchmark([entry(5, 1, 120, null, false, [5])], 90);
    expect(bench.avg_gap_s).toBeNull();
    expect(bench.avg_bl_offset_s).toBeNull();
    expect(bench.bl_pct).toBe(0);
  });
});

describe('buildHoldTargets', () => {
  const emptyHolds = (count: number): CdSummary[] =>
    Array.from({ length: count }, () => ({
      name: 'Shadow Blades', total_uses: 1, first_cast_s: 0, bl_aligned: false, bl_offset_s: null,
      cast_times_s: [], hold_windows: [], cast_pattern: 'on_cooldown' as const, fight_duration_s: 200,
    }));
  const heldAt = (castIndex: number, actualS: number, delayS: number, holds: number): CdSummary[] =>
    Array.from({ length: holds }, () => ({
      name: 'Shadow Blades', total_uses: 2, first_cast_s: 0, bl_aligned: false, bl_offset_s: null,
      cast_times_s: [], hold_windows: [{ cast_index: castIndex, actual_s: actualS, delay_s: delayS }],
      cast_pattern: 'hold' as const, fight_duration_s: 200,
    }));

  it('surfaces a target when a majority of parses hold at that index', () => {
    // 5 of 10 hold index 2 -> meets max(2, 0.5*10=5).
    const targets = buildHoldTargets([...heldAt(2, 110, 20, 5), ...emptyHolds(5)], 90);
    expect(targets['2']).toBeDefined();
    expect(targets['2'].count).toBe(5);
  });

  it('drops a target below the majority (strict boundary)', () => {
    // 4 of 10 hold -> below max(2, 5).
    expect(buildHoldTargets([...heldAt(2, 110, 20, 4), ...emptyHolds(6)], 90)['2']).toBeUndefined();
  });

  it('records prior-relative delay, absolute target, and a band floored at 5s', () => {
    // identical delays -> stddev 0 -> band floored at HOLD_BAND_MIN_S.
    const targets = buildHoldTargets(heldAt(2, 110, 20, 3), 90);
    expect(targets['2']).toMatchObject({ target_s: 110, delay_s: 20, band_s: 5, effective_cd_s: 90 });
  });
});

describe('computeEfficiencyThresholds', () => {
  it('derives a p90 downtime floor and per-parse efficiency mean', () => {
    const result = computeEfficiencyThresholds([[500, 600, 700, 5000]], [100]);
    expect(result.downtimeThresholdMs).toBeGreaterThan(0);
    expect(result.topAvgEfficiency).toBeGreaterThan(0);
    expect(result.topAvgEfficiency).toBeLessThanOrEqual(100);
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

/* ----------------------------- service (end to end, fake client) ----------------------------- */

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

const wclFake = {
  getRankings: async () => [
    { name: 'P1', report: { code: 'r1', fightID: 1 } },
    { name: 'P2', report: { code: 'r2', fightID: 2 } },
  ],
  getReport: async (code: string) => (code === 'r1' ? reportFor(10, 'P1', 1) : reportFor(20, 'P2', 2)),
  getAllEvents: async (_code: string, _fightId: number, dataType: string) =>
    dataType === 'Casts' ? [cast(SHADOW_BLADES, 5), cast(99, 8)] : [buff(BLOODLUST, 6)],
  // Resolves a real icon + name for every requested spell id (gameData.ability).
  getAbilities: async (ids: number[]) =>
    Object.fromEntries(ids.map(id => [id, { icon: 'sb', name: 'Shadow Blades' }])),
};
const filesFake = {
  getRulebook: async () => ({
    spec: 'SubtletyRogue',
    major_cooldowns: [{ name: 'Shadow Blades', spell_id: SHADOW_BLADES, cooldown: 90, align_with_bloodlust: true }],
    defensives: [],
    rules: [],
  }),
};

describe('RotationTransformService (live, in-browser)', () => {
  it('computes a rotation bench from the top parses', async () => {
    TestBed.configureTestingModule({
      providers: [
        { provide: WclApiService, useValue: wclFake as unknown as WclApiService },
        { provide: DataFileApiService, useValue: filesFake as unknown as DataFileApiService },
      ],
    });
    const bench = await TestBed.inject(RotationTransformService).getRotationBench('SubtletyRogue', 1);
    expect(bench).not.toBeNull();
    expect(bench!.sample_count).toBe(2);
    expect(bench!.encounter_name).toBe('Boss');
    expect(bench!.cd_spell_ids).toEqual({ 'Shadow Blades': SHADOW_BLADES });
    expect(bench!.per_cd_benchmarks['Shadow Blades'].sample_count).toBe(2);
    expect(bench!.ability_icons[SHADOW_BLADES]).toEqual({ icon: 'sb', name: 'Shadow Blades' });
    expect(bench!.major_cooldowns).toHaveLength(1);
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
    const bench = await TestBed.inject(RotationTransformService).getRotationBench('SubtletyRogue', 1);
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
    expect(await TestBed.inject(RotationTransformService).getRotationBench('SubtletyRogue', 1)).toBeNull();
  });
});
