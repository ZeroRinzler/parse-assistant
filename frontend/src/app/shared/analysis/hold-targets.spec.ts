import { describe, it, expect } from 'vitest';
import {
  HOLD_BAND_MIN_S, HoldWindowSource, buildHoldTargets, detectHoldWindows, holdSuggestionFindings,
} from './hold-targets';
import { CdHoldTargets } from '../../core/models/encounter.models';

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

describe('buildHoldTargets', () => {
  const EFFECTIVE_CD_S = 90;
  const HELD_INDEX = 2;

  const heldAt = (actualS: number, delayS: number, parses: number): HoldWindowSource[] =>
    Array.from({ length: parses }, () => ({
      hold_windows: [{ cast_index: HELD_INDEX, actual_s: actualS, delay_s: delayS }],
    }));
  const noHolds = (parses: number): HoldWindowSource[] =>
    Array.from({ length: parses }, () => ({ hold_windows: [] }));

  it('surfaces a target when a majority of parses hold at that index', () => {
    // 5 of 10 hold index 2 -> meets max(2, 0.5 * 10 = 5).
    const targets = buildHoldTargets([...heldAt(110, 20, 5), ...noHolds(5)], EFFECTIVE_CD_S);
    expect(targets[String(HELD_INDEX)]).toBeDefined();
    expect(targets[String(HELD_INDEX)].count).toBe(5);
  });

  it('drops a target below the majority (strict boundary)', () => {
    // 4 of 10 hold -> below max(2, 5).
    const targets = buildHoldTargets([...heldAt(110, 20, 4), ...noHolds(6)], EFFECTIVE_CD_S);
    expect(targets[String(HELD_INDEX)]).toBeUndefined();
  });

  it('records prior-relative delay, absolute target, and a band floored at 5s', () => {
    // identical delays -> stddev 0 -> band floored at HOLD_BAND_MIN_S.
    const targets = buildHoldTargets(heldAt(110, 20, 3), EFFECTIVE_CD_S);
    expect(targets[String(HELD_INDEX)]).toMatchObject({
      target_s: 110, delay_s: 20, band_s: HOLD_BAND_MIN_S, effective_cd_s: EFFECTIVE_CD_S,
    });
  });

  it('bands on the delay spread when it clears the floor', () => {
    const spread: HoldWindowSource[] = [
      { hold_windows: [{ cast_index: HELD_INDEX, actual_s: 100, delay_s: 40 }] },
      { hold_windows: [{ cast_index: HELD_INDEX, actual_s: 130, delay_s: 50 }] },
    ];
    // median actual 115, median delay 45; delays [40, 50] give sample stddev sqrt(50) = 7.07 -> 7.1.
    expect(buildHoldTargets(spread, EFFECTIVE_CD_S)).toMatchObject({
      [String(HELD_INDEX)]: { target_s: 115, delay_s: 45, band_s: 7.1 },
    });
  });

  it('keys consensus on the sample size passed, not the holders alone', () => {
    const TOTAL_PARSES = 6;  // 2 holders of 6 sampled -> below max(2, 0.5 * 6 = 3)
    expect(buildHoldTargets(heldAt(110, 20, 2), EFFECTIVE_CD_S, TOTAL_PARSES)).toEqual({});
  });
});

describe('holdSuggestionFindings', () => {
  const NAME = 'Shadow Blades';
  // Prior-relative band: the top parses hold this cast HOLD_DELAY_S past the reset, and a player
  // is flagged only when their own gap from their prior cast falls more than HOLD_BAND_S below
  // that. Over-holding is tolerated.
  const HELD_CAST_INDEX = 2;      // the second cast (1-based key)
  const EFFECTIVE_CD_S = 60;      // the cooldown (cadence zero-point)
  const HOLD_DELAY_S = 40;        // top parses hold ~40s past the reset
  const HOLD_BAND_S = 5;          // tolerance half-width
  const TARGET_CLOCK_S = 130;     // display-only median clock target ("hold to 02:10")
  const HELD_COUNT = 6;           // "6 of 10 top parses hold" copy
  const TOTAL_SAMPLED = 10;
  const PRIOR_CAST_S = 10;
  const BAND_EDGE_S = PRIOR_CAST_S + EFFECTIVE_CD_S + (HOLD_DELAY_S - HOLD_BAND_S);
  const UNDER_HELD_S = BAND_EDGE_S - 5;
  const OVER_HELD_S = PRIOR_CAST_S + EFFECTIVE_CD_S + HOLD_DELAY_S + 20;

  const targetAt = (castIndex: number): CdHoldTargets => ({
    [castIndex]: {
      target_s: TARGET_CLOCK_S, stddev_s: HOLD_BAND_S,
      delay_s: HOLD_DELAY_S, delay_stddev_s: 3, band_s: HOLD_BAND_S, effective_cd_s: EFFECTIVE_CD_S,
      count: HELD_COUNT, total_samples: TOTAL_SAMPLED,
    },
  });
  const holdTargets = targetAt(HELD_CAST_INDEX);

  it('suggests a hold when the player under-held vs the prior-relative band', () => {
    const out = holdSuggestionFindings(NAME, [PRIOR_CAST_S, UNDER_HELD_S], holdTargets);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ severity: 'info', category: 'hold_suggestion' });
  });

  it('reports the cast clock and the consensus in the message', () => {
    const [finding] = holdSuggestionFindings(NAME, [PRIOR_CAST_S, UNDER_HELD_S], holdTargets);
    expect(finding.message).toContain(`${HELD_COUNT}/${TOTAL_SAMPLED} top parses hold to 02:10`);
    expect(finding.details?.cd_name).toBe(NAME);
  });

  it('does not suggest at the band edge (strict boundary)', () => {
    expect(holdSuggestionFindings(NAME, [PRIOR_CAST_S, BAND_EDGE_S], holdTargets)).toEqual([]);
  });

  it('tolerates over-holding (a later-than-band press is fine)', () => {
    expect(holdSuggestionFindings(NAME, [PRIOR_CAST_S, OVER_HELD_S], holdTargets)).toEqual([]);
  });

  it('skips index 0 - no prior cast to measure a gap against', () => {
    const PLAYER_FIRST_S = 80;
    expect(holdSuggestionFindings(NAME, [PLAYER_FIRST_S], targetAt(1))).toEqual([]);
  });

  it('skips a cast index the player never reached', () => {
    expect(holdSuggestionFindings(NAME, [PRIOR_CAST_S], holdTargets)).toEqual([]);
  });

  it('returns nothing when the player never cast the ability', () => {
    expect(holdSuggestionFindings(NAME, [], holdTargets)).toEqual([]);
  });
});
