import { assert, describe, it, expect } from 'vitest';
import { PlayerDefensive } from '../../../core/models/analysis.models';
import { PerDefensiveBenchmark } from '../../../core/models/encounter.models';
import {
  analyzeDefensives, analyzeDefensiveFindings,
  buildDefensiveUsageWindows, analyzeOneDefensive,
} from './defensive.service';
import { applyBuff, removeBuff, cast } from '../../../../testing/builders/events';
import { CLOAK_OF_SHADOWS } from '../../../../testing/spell-ids';
import { CLOAK_META, defBench, timed } from './defensive-harness';

describe('analyzeDefensives', () => {
  // Composition only: span shapes and fallbacks are specced on buildDefensiveUsageWindows.
  it('builds buff-window-centric uses', () => {
    const out = analyzeDefensives(
      [CLOAK_META],
      [], timed([applyBuff(CLOAK_OF_SHADOWS, 10), removeBuff(CLOAK_OF_SHADOWS, 15)], 0),
      300,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ name: 'Cloak of Shadows', uses: 1, cast_times_s: [10] });
    assert.exists(out[0]);
    expect(out[0].windows[0]).toMatchObject({ start_s: 10, end_s: 15 });
  });

  // Composition only: back-fill semantics are specced on buildAuraWindows.
  it('reads a bare removeBuff with no preceding apply as one use starting at 0:00', () => {
    const REMOVE_S = 15;
    const out = analyzeDefensives(
      [CLOAK_META],
      [], timed([removeBuff(CLOAK_OF_SHADOWS, REMOVE_S)], 0),
      300,
    );
    expect(out[0]).toMatchObject({ uses: 1, cast_times_s: [0] });
    assert.exists(out[0]);
    expect(out[0].windows[0]).toMatchObject({ start_s: 0, end_s: REMOVE_S });
  });
});

describe('buildDefensiveUsageWindows', () => {
  const FIGHT_END_S = 300;

  it('builds a measured buff span, open buff running to fight end', () => {
    const BUFF_START_S = 10;
    const out = buildDefensiveUsageWindows(CLOAK_OF_SHADOWS, [[BUFF_START_S, null]], [], FIGHT_END_S);
    expect(out).toEqual([{ start_s: BUFF_START_S, end_s: FIGHT_END_S }]);
  });

  it('falls back to point casts (zero span) only when there is no buff span', () => {
    const CAST_S = 20;
    const out = buildDefensiveUsageWindows(
      CLOAK_OF_SHADOWS, [], timed([cast(CLOAK_OF_SHADOWS, CAST_S)], 0),
      FIGHT_END_S,
    );
    expect(out).toEqual([{ start_s: CAST_S, end_s: CAST_S }]);
  });

  it('ignores a cast outside the fight bounds (boundary)', () => {
    const PAST_END_S = 301; // > FIGHT_END_S
    const out = buildDefensiveUsageWindows(
      CLOAK_OF_SHADOWS, [], timed([cast(CLOAK_OF_SHADOWS, PAST_END_S)], 0),
      FIGHT_END_S,
    );
    expect(out).toEqual([]);
  });
});

describe('analyzeOneDefensive', () => {
  // Full use-share bench (10/10 top parses used it), so no check is use-share gated.
  const bench = defBench({ sample_count: 10, used_sample_count: 10 });
  const player = (overrides: Partial<PlayerDefensive>): PlayerDefensive =>
    ({ name: 'Cloak of Shadows', uses: 0, cast_times_s: [], windows: [], ...overrides });
  const FIGHT_DUR_S = 300;

  it('flags a never-used defensive as a critical lost cooldown', () => {
    const out = analyzeOneDefensive(player({ uses: 0, cast_times_s: [] }), bench, 300);
    expect(out[0]).toMatchObject({ severity: 'critical', category: 'lost_cooldown' });
  });

  it('flags a late first use as a warning', () => {
    // First use is well past avg 10 + 2*stddev 2 = 14s -> a first-cast delay warning.
    const LATE_FIRST_S = 40;
    const out = analyzeOneDefensive(player({ uses: 1, cast_times_s: [LATE_FIRST_S] }), bench, FIGHT_DUR_S);
    expect(out.some(finding => finding.severity === 'warning' && finding.category === 'cooldown_delay')).toBe(true);
  });

  // used_sample_count / sample_count below MIN_USE_SHARE_FRAC (0.5) -> a situational defensive.
  const TOTAL_SAMPLED = 10;
  const MINORITY_USERS = 3;       // 3/10 = 30% < 50%
  const minorityUse: PerDefensiveBenchmark = { ...bench, sample_count: TOTAL_SAMPLED, used_sample_count: MINORITY_USERS };

  it('does not flag an unused defensive that only a minority of top parses use (use-share gate)', () => {
    // The player matching the top parses by not pressing it is not a lost cast.
    expect(analyzeOneDefensive(player({ uses: 0, cast_times_s: [] }), minorityUse, FIGHT_DUR_S)).toEqual([]);
  });

  it('does not flag a late first use of a minority-use defensive (use-share gate)', () => {
    // First use is well past avg 10 + 2*stddev 2 = 14s, but the first-cast check is gated off.
    const LATE_FIRST_S = 40;
    const out = analyzeOneDefensive(player({ uses: 1, cast_times_s: [LATE_FIRST_S] }), minorityUse, FIGHT_DUR_S);
    expect(out.some(finding => finding.category === 'cooldown_delay')).toBe(false);
  });

  it('returns a success (no issues) when usage matches', () => {
    const out = analyzeOneDefensive(player({ uses: 2, cast_times_s: [10, 70] }), bench, 300);
    expect(out.some(finding => finding.severity === 'success')).toBe(true);
  });

  it('skips a talent-gated defensive that was never used', () => {
    expect(analyzeOneDefensive(player({ uses: 0, talent_gated: true }), bench, 300)).toEqual([]);
  });

  it('records a no-bench success only when used', () => {
    expect(analyzeOneDefensive(player({ uses: 1, cast_times_s: [10] }), undefined, 300)[0]).toMatchObject({ severity: 'success' });
    expect(analyzeOneDefensive(player({ uses: 0 }), undefined, 300)).toEqual([]);
  });
});

describe('analyzeDefensiveFindings', () => {
  // Composition only: per-defensive checks are specced on analyzeOneDefensive.
  const bench: Record<string, PerDefensiveBenchmark> = { 'Cloak of Shadows': defBench({ sample_count: 10, used_sample_count: 10 }) };

  it('flags a never-used defensive as a critical lost cooldown', () => {
    const findings = analyzeDefensiveFindings(
      [{ name: 'Cloak of Shadows', uses: 0, cast_times_s: [], windows: [] }],
      bench, 300,
    );
    expect(findings[0]).toMatchObject({ severity: 'critical', category: 'lost_cooldown', cd_name: 'Cloak of Shadows' });
  });
});
