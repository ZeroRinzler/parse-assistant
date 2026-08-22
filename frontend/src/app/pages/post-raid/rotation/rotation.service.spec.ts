import { assert, describe, it, expect } from 'vitest';
import { RulebookCooldown } from '../../../core/models/rulebook.models';
import { SHADOW_BLADES, BLOODLUST } from '../../../../testing/spell-ids';
import { cast, applyBuff } from '../../../../testing/builders/events';
import { WclEvent } from '../../../core/models/wcl.models';
import { withRelativeS } from '../../../shared/analysis/wcl-projections';
import { RotationBench } from './rotation-data-source';
import { detectBloodlust } from './rotation-bloodlust';
import {
  analyzeRotationFindings, RotationScanInput, checkBloodlustAlignment,
  checkCastEfficiency, analyzeOneCooldown,
} from './rotation.service';
import { bench, cdBench } from './rotation-harness';

// Build a RotationScanInput for a 0..120s fight - keeps the call sites terse.
function scan(over: {
  bench: RotationBench; fightDurationS?: number; castEvents?: WclEvent[]; buffEvents?: WclEvent[]; cooldowns?: RulebookCooldown[];
}): RotationScanInput {
  return {
    bench: over.bench,
    fightDurationS: over.fightDurationS ?? 120,
    castEvents: withRelativeS(over.castEvents ?? [], 0),
    buffEvents: withRelativeS(over.buffEvents ?? [], 0),
    cooldowns: over.cooldowns ?? over.bench.major_cooldowns,
  };
}

describe('analyzeRotationFindings', () => {
  it('emits a lost-cooldown critical when never used and expected', () => {
    const findings = analyzeRotationFindings(scan({ bench: bench() }));
    const lost = findings.find(f => f.category === 'lost_cooldown');
    expect(lost?.severity).toBe('critical');
  });

  it('emits a success when used on cd and BL-aligned', () => {
    const casts = [cast(SHADOW_BLADES, 6)];
    const buffs = [applyBuff(BLOODLUST, 6)];
    const single = bench({ per_cd_benchmarks: { 'Shadow Blades': cdBench({ uses_per_min: { avg: 0.5, stddev: 0.1 } }) } });
    const findings = analyzeRotationFindings(scan({ castEvents: casts, buffEvents: buffs, bench: single }));
    const success = findings.find(f => f.category === 'cooldown_usage' && f.severity === 'success');
    expect(success).toBeDefined();
    assert.exists(success);
    expect(success.message).toContain('BL-aligned');
  });

  it('flags a late opener', () => {
    const casts = [cast(SHADOW_BLADES, 40)];
    const buffs = [applyBuff(BLOODLUST, 38)];
    const findings = analyzeRotationFindings(scan({ castEvents: casts, buffEvents: buffs, bench: bench() }));
    expect(findings.some(f => f.category === 'cooldown_delay')).toBe(true);
  });

  it('gives the cast-efficiency finding a label and a remedy so the row is not blank', () => {
    // A 24s idle gap on the 120s scan fight = 80% efficiency, below the 87% (top avg 90 minus 1 sigma) warn threshold.
    const FIRST_CAST_S = 6;
    const LATE_CAST_S = 30;
    const casts = [cast(SHADOW_BLADES, FIRST_CAST_S), cast(SHADOW_BLADES, LATE_CAST_S)];
    const findings = analyzeRotationFindings(scan({ castEvents: casts, bench: bench() }));
    const efficiency = findings.find(f => f.category === 'cast_efficiency');
    expect(efficiency).toBeDefined();
    assert.exists(efficiency);
    expect(efficiency.label).toBeTruthy();
    assert.exists(efficiency);
    expect(efficiency.details?.remedy).toBeTruthy();
  });
});

describe('analyzeRotationFindings Bloodlust detection', () => {
  // Aligned window [blTimeS-30, blTimeS+55]; offset from blTimeS must stay within 4s (2*stddev) to avoid an alignment warning.
  const LOW_UPM = { avg: 0.5, stddev: 0.1, min: 0.4, max: 0.6 };
  const single = bench({ per_cd_benchmarks: { 'Shadow Blades': cdBench({ uses_per_min: LOW_UPM }) } });
  // Casts stay >= 0 (still bounded by fight start), so it opens right on the pull.
  const OPEN_CAST_S = 0;

  it('drives BL-aligned coaching from a Bloodlust popped before the pull (negative atS)', () => {
    // WCL's fight start is the first damage event, so a pre-cast Lust lands at a negative atS.
    const PRE_PULL_BL_S = -2;
    const casts = [cast(SHADOW_BLADES, OPEN_CAST_S)];
    const buffs = [applyBuff(BLOODLUST, PRE_PULL_BL_S)];
    const findings = analyzeRotationFindings(scan({ castEvents: casts, buffEvents: buffs, bench: single }));
    const success = findings.find(f => f.category === 'cooldown_usage' && f.severity === 'success');
    expect(success?.message).toContain('BL-aligned');
  });

  it('drives BL-aligned coaching from a Bloodlust popped exactly at fight start (boundary)', () => {
    const FIGHT_START_S = 0;
    const casts = [cast(SHADOW_BLADES, OPEN_CAST_S)];
    const buffs = [applyBuff(BLOODLUST, FIGHT_START_S)];
    const findings = analyzeRotationFindings(scan({ castEvents: casts, buffEvents: buffs, bench: single }));
    const success = findings.find(f => f.category === 'cooldown_usage' && f.severity === 'success');
    expect(success?.message).toContain('BL-aligned');
  });

  it('agrees with the ingest bench on the same buff stream, so neither path can diverge', () => {
    const PRE_PULL_BL_S = -2;
    const buffs = [applyBuff(BLOODLUST, PRE_PULL_BL_S)];
    // RotationTransformService's ingest bench calls this same function on the same buff stream.
    expect(detectBloodlust(withRelativeS(buffs, 0))).toBe(PRE_PULL_BL_S);
    const casts = [cast(SHADOW_BLADES, OPEN_CAST_S)];
    const findings = analyzeRotationFindings(scan({ castEvents: casts, buffEvents: buffs, bench: single }));
    const success = findings.find(f => f.category === 'cooldown_usage' && f.severity === 'success');
    expect(success?.message).toContain('BL-aligned');
  });
});

describe('analyzeRotationFindings hold suggestions (prior-relative)', () => {
  const holdBench = bench({
    per_cd_benchmarks: { 'Shadow Blades': cdBench({
      hold_targets: { '2': { target_s: 130, delay_s: 30, band_s: 5, effective_cd_s: 90, count: 4, total_samples: 5 } },
    }) },
  });

  it('flags an under-hold below the consensus band', () => {
    // gap 100, effective_cd 90 -> playerDelay 10 < (delay 30 - band 5 = 25).
    const casts = [cast(SHADOW_BLADES, 0), cast(SHADOW_BLADES, 100)];
    const findings = analyzeRotationFindings(scan({ castEvents: casts, bench: holdBench }));
    expect(findings.some(f => f.category === 'hold_suggestion')).toBe(true);
  });

  it('does not flag a player exactly at the band edge (strict)', () => {
    // gap 115 -> playerDelay 25, exactly delay - band; strict < so not flagged.
    const casts = [cast(SHADOW_BLADES, 0), cast(SHADOW_BLADES, 115)];
    const findings = analyzeRotationFindings(scan({ castEvents: casts, bench: holdBench }));
    expect(findings.some(f => f.category === 'hold_suggestion')).toBe(false);
  });

  it('does not flag an over-hold', () => {
    const casts = [cast(SHADOW_BLADES, 0), cast(SHADOW_BLADES, 160)];
    const findings = analyzeRotationFindings(scan({ castEvents: casts, bench: holdBench }));
    expect(findings.some(f => f.category === 'hold_suggestion')).toBe(false);
  });
});

describe('checkBloodlustAlignment', () => {
  const BL_AT_S = 10;
  // BL window: 30s before BL to 40s duration + 15s trail -> [-30, +55] around BL_AT_S = [-20, 65].

  it('flags a BL miss when the cooldown lands outside the window and parsers align it', () => {
    // cast at 100s is outside [-20, 65]; wantsBL true.
    const out = checkBloodlustAlignment('Shadow Blades', [100], cdBench(), BL_AT_S, true);
    expect(out.blAligned).toBe(false);
    expect(out.findings[0]?.measured).toEqual({ value: 'missed', unit: 'BL' });
  });

  it('does not flag a miss when parsers do not align it', () => {
    const out = checkBloodlustAlignment('Shadow Blades', [100], cdBench(), BL_AT_S, false);
    expect(out.blAligned).toBe(false);
    expect(out.findings).toEqual([]);
  });

  it('flags an in-window offset more than 2 sigma off the top offset', () => {
    // avg_bl_offset 0, stddev 2 -> outlier beyond |offset| > 4. Cast at BL+5s -> offset 5.
    const out = checkBloodlustAlignment('Shadow Blades', [(BL_AT_S + 5)], cdBench(), BL_AT_S, true);
    expect(out.blAligned).toBe(true);
    expect(out.findings[0]?.measured).toEqual({ value: 'late', unit: 'in BL' });
  });

  it('does not flag an in-window offset exactly at the 2-sigma boundary (strict)', () => {
    // offset exactly 4 == 2*stddev; strict so not flagged.
    const out = checkBloodlustAlignment('Shadow Blades', [(BL_AT_S + 4)], cdBench(), BL_AT_S, true);
    expect(out.blAligned).toBe(true);
    expect(out.findings).toEqual([]);
  });

  it('stamps the judged cast, not the earliest in-window cast', () => {
    // avg_bl_offset -8, stddev 2 -> in-band [-12, -4]; the later cast (closest to zero) is judged, not the earlier in-band one.
    const EARLY_IN_BAND_S = BL_AT_S - 8;
    const LATE_JUDGED_S = BL_AT_S - 2;
    const out = checkBloodlustAlignment(
      'Shadow Blades', [EARLY_IN_BAND_S, LATE_JUDGED_S],
      cdBench({ avg_bl_offset_s: -8, stddev_bl_offset_s: 2 }), BL_AT_S, true);
    expect(out.findings[0]?.measured).toEqual({ value: 'late', unit: 'in BL' });
    expect(out.findings[0]?.timestamp_s).toBe(LATE_JUDGED_S);
  });

  it('returns not-aligned with no BL', () => {
    expect(checkBloodlustAlignment('Shadow Blades', [5], cdBench(), null, true))
      .toEqual({ blAligned: false, findings: [] });
  });
});

describe('checkCastEfficiency', () => {
  const FIGHT_DUR_S = 120;
  // bench(): top_avg_efficiency 90%, top_efficiency_stddev 3% -> warn strictly below 87% (top - 1 sigma).
  const IDLE_BELOW_BAND_S = 20;   // -> 83.3%, below the 87% warn threshold
  const IDLE_FAR_BELOW_S = 60;    // -> 50%, far below the band
  const IDLE_ABOVE_AVG_S = 1.6; // just over the 1.5s downtime floor -> 98.7%, above top avg

  it('flags low cast efficiency more than 1 sigma below the top parses', () => {
    const finding = checkCastEfficiency([0, IDLE_BELOW_BAND_S], FIGHT_DUR_S, bench());
    expect(finding?.category).toBe('cast_efficiency');
    expect(finding?.severity).toBe('warning');
    expect(finding?.details?.remedy).toBeTruthy();
  });

  it('never escalates to critical, however far below', () => {
    expect(checkCastEfficiency([0, IDLE_FAR_BELOW_S], FIGHT_DUR_S, bench())?.severity).toBe('warning');
  });

  it('does not flag efficiency exactly at the 1-sigma boundary (strict), but flags one bin below', () => {
    // Binary-exact bench: top avg 80%, stddev 5% -> warn strictly below 75%.
    const boundaryBench = bench({ top_avg_efficiency: 80, top_efficiency_stddev: 5 });
    const BOUNDARY_FIGHT_S = 128;
    // 32s idle -> exactly 75% = top - 1 sigma: strict boundary, no finding.
    expect(checkCastEfficiency([0, 32], BOUNDARY_FIGHT_S, boundaryBench)).toBeNull();
    // 33s idle -> 74.21875% < 75%: one bin below the boundary, warns.
    expect(checkCastEfficiency([0, 33], BOUNDARY_FIGHT_S, boundaryBench)?.severity).toBe('warning');
  });

  it('does not flag when the player beats the top parses', () => {
    expect(checkCastEfficiency([0, IDLE_ABOVE_AVG_S], FIGHT_DUR_S, bench())).toBeNull();
  });

  it('returns null with fewer than two casts', () => {
    expect(checkCastEfficiency([0], FIGHT_DUR_S, bench())).toBeNull();
  });
});

describe('analyzeOneCooldown', () => {
  const FIGHT_DUR_S = 120;
  const UPM = { avg: 0.5, stddev: 0.1 };  // top-parse uses-per-minute
  const cd = { name: 'Shadow Blades', spell_id: SHADOW_BLADES, cooldown: 90 };
  const single = cdBench({ uses_per_min: UPM });
  // A cooldown a minority of top parses use: used/sample below MIN_USE_SHARE_FRAC (0.5).
  const TOTAL_SAMPLED = 10;
  const MINORITY_USERS = 2;  // 2/10 = 20%
  const rareUse = cdBench({ sample_count: TOTAL_SAMPLED, used_sample_count: MINORITY_USERS, uses_per_min: UPM });

  it('skips a talent-gated cooldown that was never used', () => {
    expect(analyzeOneCooldown({ ...cd, talent_gated: true }, [], single, 120, null)).toBeNull();
  });

  it('reports success when a cooldown is used cleanly and BL-aligned', () => {
    // first cast 6s (under 9s open threshold), BL at 6s -> aligned.
    const result = analyzeOneCooldown(cd, [6], single, 120, 6);
    expect(result?.scan.issues).toEqual([]);
    expect(result?.success?.message).toContain('BL-aligned');
  });

  it('reports an issue (no success) when the opener is late', () => {
    const result = analyzeOneCooldown(cd, [40], single, 120, 38);
    expect(result?.success).toBeNull();
    expect(result?.scan.issues.some(finding => finding.category === 'cooldown_delay')).toBe(true);
  });

  it('does not flag an unused cooldown that only a minority of top parses use (use-share gate)', () => {
    // Matching the top parses by not pressing it is not a lost cast.
    const result = analyzeOneCooldown(cd, [], rareUse, FIGHT_DUR_S, null);
    expect(result?.scan.issues).toEqual([]);
    expect(result?.success).toBeNull();
  });

  it('does not flag a late opener of a minority-use cooldown (use-share gate)', () => {
    // Opened well past 2 sigma over the 5s top first cast, but the first-cast check is gated off.
    const LATE_OPENER_S = 40;
    const result = analyzeOneCooldown(cd, [LATE_OPENER_S], rareUse, FIGHT_DUR_S, null);
    expect(result?.scan.issues.some(finding => finding.category === 'cooldown_delay')).toBe(false);
  });
});
