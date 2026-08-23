import { describe, it, expect } from 'vitest';
import { CadenceBenchmark } from '../encounter/encounter.models';
import { CadenceEntry, CadenceVoice, CastCadenceService } from './cast-cadence-service';
import { TestBed } from '@angular/core/testing';

const castCadence = TestBed.inject(CastCadenceService);

const FIGHT_DUR_S = 300;

function user(over: Partial<CadenceEntry> = {}): CadenceEntry {
  return { cast_times_s: [10], first_cast_s: 10, fight_duration_s: FIGHT_DUR_S, hold_windows: [], cast_pattern: 'on_cooldown', ...over };
}

function bench(over: Partial<CadenceBenchmark> = {}): CadenceBenchmark {
  return {
    sample_count: 5, used_sample_count: 5, avg_first_cast_s: 5, stddev_first_cast_s: 2,
    avg_gap_s: 90, stddev_gap_s: 5, hold_targets: {}, median_uses: 2,
    uses_per_min: { avg: 1, stddev: 0.1 }, majority_hold: false,
    ...over,
  };
}

// A voice with distinct wording, so every assertion proves the words came from the voice, not a hardcoded slice string.
const VOICE: CadenceVoice = {
  unit: 'press(es)',
  firstCastPhrase: 'opened at',
  gapNoun: 'presses',
  underuseRemedy: (name, missing) => `${name} +${missing}`,
  firstCastRemedy: name => `${name} earlier`,
  gapRemedy: (name, avgGapS) => `${name} every ${avgGapS}s`,
};

describe('buildCadenceBenchmark', () => {
  it('derives first-cast / gap / uses-per-min and the total/used sample split', () => {
    const TOTAL_PARSES = 3;   // 2 users of 3 sampled parses
    const FIRST_A_S = 10, SECOND_A_S = 140;   // gap 130
    const FIRST_B_S = 20, SECOND_B_S = 160;   // gap 140
    const EXPECTED_AVG_FIRST_CAST_S = (FIRST_A_S + FIRST_B_S) / 2;                       // 15
    const EXPECTED_AVG_GAP_S = ((SECOND_A_S - FIRST_A_S) + (SECOND_B_S - FIRST_B_S)) / 2; // 135
    const USERS = 2;
    const out = castCadence.buildCadenceBenchmark([
      user({ cast_times_s: [FIRST_A_S, SECOND_A_S], first_cast_s: FIRST_A_S }),
      user({ cast_times_s: [FIRST_B_S, SECOND_B_S], first_cast_s: FIRST_B_S }),
    ], 120, TOTAL_PARSES);
    expect(out.sample_count).toBe(TOTAL_PARSES);
    expect(out.used_sample_count).toBe(USERS);
    expect(out.avg_first_cast_s).toBe(EXPECTED_AVG_FIRST_CAST_S);
    expect(out.avg_gap_s).toBe(EXPECTED_AVG_GAP_S);
    // uses/min per parse: 2/300*60 = 0.4 for both -> mean 0.4.
    expect(out.uses_per_min).toMatchObject({ avg: 0.4 });
  });

  it('keeps median_uses steady against a single outlier', () => {
    const TYPICAL_USES = 3;
    const OUTLIER_USES = 20;
    const times = (uses: number): number[] => Array.from({ length: uses }, (_, i) => 5 + i * 10);
    const users = [TYPICAL_USES, TYPICAL_USES, TYPICAL_USES, OUTLIER_USES]
      .map(uses => user({ cast_times_s: times(uses), first_cast_s: 5 }));
    expect(castCadence.buildCadenceBenchmark(users, 120, users.length).median_uses).toBe(TYPICAL_USES);
  });

  it('sentinels the user-only stats when no sampled parse ever used it (empty case)', () => {
    const TOTAL_PARSES = 2;
    const out = castCadence.buildCadenceBenchmark([], 90, TOTAL_PARSES);
    expect(out.sample_count).toBe(TOTAL_PARSES);
    expect(out.used_sample_count).toBe(0);
    expect(out.median_uses).toBe(0);
    expect(out.majority_hold).toBe(false);
  });

  it('leaves gap fields null for single-cast parses', () => {
    const out = castCadence.buildCadenceBenchmark([user()], 90, 1);
    expect(out.avg_gap_s).toBeNull();
    expect(out.stddev_gap_s).toBeNull();
  });

  const withHolders = (holding: number, users: number): CadenceEntry[] => [
    ...Array.from({ length: holding }, () => user({ cast_pattern: 'hold' as const })),
    ...Array.from({ length: users - holding }, () => user()),
  ];

  it('sets majority_hold at an exact consensus tie among the users (inclusive boundary)', () => {
    const USERS = 10;
    const HOLDERS_AT_TIE = 5;  // exactly half of the users -> ties count as holds
    expect(castCadence.buildCadenceBenchmark(withHolders(HOLDERS_AT_TIE, USERS), 90, USERS).majority_hold).toBe(true);
  });

  it('clears majority_hold when fewer than half the users hold', () => {
    const USERS = 10;
    const HOLDERS_BELOW = 4;
    expect(castCadence.buildCadenceBenchmark(withHolders(HOLDERS_BELOW, USERS), 90, USERS).majority_hold).toBe(false);
  });
});

describe('usedByMajority', () => {
  it('passes at exactly half the sampled parses (inclusive boundary)', () => {
    expect(castCadence.usedByMajority(bench({ sample_count: 10, used_sample_count: 5 }))).toBe(true);
  });

  it('fails one user below half', () => {
    expect(castCadence.usedByMajority(bench({ sample_count: 10, used_sample_count: 4 }))).toBe(false);
  });
});

describe('checkLostUses', () => {
  it('flags a critical when the ability is never used but expected', () => {
    const finding = castCadence.checkLostUses(VOICE, 'Cloak', 0, 2, 2, FIGHT_DUR_S);
    expect(finding).toMatchObject({ severity: 'critical', category: 'lost_cooldown', measured: { value: '0 / 2', unit: 'press(es)' } });
  });

  it('flags a critical below the floor, with the voice remedy', () => {
    // 1 use, floor 3 -> 2 missing.
    const finding = castCadence.checkLostUses(VOICE, 'Cloak', 1, 3, 3, FIGHT_DUR_S);
    expect(finding?.category).toBe('lost_cooldown');
    expect(finding?.details?.remedy).toBe('Cloak +2');
  });

  it('does not flag a use count exactly at the floor (strict)', () => {
    expect(castCadence.checkLostUses(VOICE, 'Cloak', 2, 2, 2, FIGHT_DUR_S)).toBeNull();
  });
});

describe('checkFirstCastDelay', () => {
  // bench: avg_first_cast_s 5, stddev 2 -> outlier above 5 + 2*2 = 9s.

  it('flags a first cast more than 2 sigma past the top open, voicing the remedy', () => {
    const finding = castCadence.checkFirstCastDelay(VOICE, 'Cloak', [10], bench());
    expect(finding?.category).toBe('cooldown_delay');
    expect(finding?.message).toContain('opened at');
    expect(finding?.details?.remedy).toBe('Cloak earlier');
  });

  it('does not flag a first cast exactly at the 2-sigma boundary (strict)', () => {
    expect(castCadence.checkFirstCastDelay(VOICE, 'Cloak', [9], bench())).toBeNull();
  });

  it('returns null with no casts', () => {
    expect(castCadence.checkFirstCastDelay(VOICE, 'Cloak', [], bench())).toBeNull();
  });
});

describe('checkGaps', () => {
  // bench: avg_gap_s 90, stddev 5 -> outlier above 90 + 2*5 = 100s.

  it('flags a gap more than 2 sigma above the top gap, voicing noun and remedy', () => {
    const out = castCadence.checkGaps(VOICE, 'Cloak', [0, 110], bench());
    expect(out).toHaveLength(1);
    expect(out[0]?.message).toContain('between presses');
    expect(out[0]?.details?.remedy).toBe('Cloak every 90s');
  });

  it('does not flag a gap exactly at the 2-sigma boundary (strict)', () => {
    expect(castCadence.checkGaps(VOICE, 'Cloak', [0, 100], bench())).toEqual([]);
  });

  it('returns nothing when the bench has no gap stats', () => {
    expect(castCadence.checkGaps(VOICE, 'Cloak', [0, 200], bench({ avg_gap_s: null, stddev_gap_s: null }))).toEqual([]);
  });
});

describe('holdsOf', () => {
  const targets = {
    '3': { target_s: 200, delay_s: 20, band_s: 5, effective_cd_s: 90, count: 4, total_samples: 5 },
    '2': { target_s: 100, delay_s: 10, band_s: 5, effective_cd_s: 90, count: 4, total_samples: 5 },
  };

  it('returns the hold targets in cast order when the holds are majority-held', () => {
    expect(castCadence.holdsOf(bench({ majority_hold: true, hold_targets: targets })))
      .toEqual([{ castIndex: 2, targetS: 100 }, { castIndex: 3, targetS: 200 }]);
  });

  it('returns nothing without a hold majority, or without a bench', () => {
    expect(castCadence.holdsOf(bench({ majority_hold: false, hold_targets: targets }))).toEqual([]);
    expect(castCadence.holdsOf(undefined)).toEqual([]);
  });
});

describe('cadencePlanUsage', () => {
  it('returns the empty-state row without a bench', () => {
    expect(castCadence.cadencePlanUsage(undefined)).toEqual({ typicalUses: null, usedSampleCount: 0, sampleCount: 0, firstCastS: null });
  });

  it('yields typical uses from any adoption, but gates first cast on the use-share majority', () => {
    const MINORITY = bench({ sample_count: 10, used_sample_count: 2, median_uses: 3, avg_first_cast_s: 12 });
    expect(castCadence.cadencePlanUsage(MINORITY)).toMatchObject({ typicalUses: 3, firstCastS: null });
  });

  it('surfaces first cast at exactly half adoption (inclusive boundary)', () => {
    const AT_HALF = bench({ sample_count: 10, used_sample_count: 5, avg_first_cast_s: 12 });
    expect(castCadence.cadencePlanUsage(AT_HALF).firstCastS).toBe(12);
  });
});
