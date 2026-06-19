import { describe, it, expect } from 'vitest';
import { analyzeCooldowns } from './cooldown-analysis';
import { AnalysisFinding } from '../models/analysis.models';
import { Events } from '../../../testing/builders/events';
import { rulebook } from '../../../testing/builders/rulebook';
import { bench } from '../../../testing/builders/bench';
import { parseClock, FIGHT_START } from '../../../testing/time';
import { SHADOW_BLADES, BLOODLUST } from '../../../testing/spell-ids';

const FIVE_MIN = parseClock('5:00');
const find = (fs: AnalysisFinding[], category: string) => fs.find((f) => f.category === category);

describe('analyzeCooldowns / lost casts', () => {
  it('emits a success finding when the CD was used and no issues detected', () => {
    const cds = rulebook({ cooldowns: [{ name: 'Shadow Blades', spell_id: SHADOW_BLADES, cooldown: 180 }] }).major_cooldowns!;
    const bk = bench({ perCd: { 'Shadow Blades': { uses_per_min: { avg: 0.4, stddev: 0, min: 0.4, max: 0.4 }, avg_uses_per_min: 0.4 } } });
    const casts = Events.cast(SHADOW_BLADES, '0:05').cast(SHADOW_BLADES, '3:05').build();

    const result = analyzeCooldowns('Rogue', 'Sub', FIGHT_START, FIVE_MIN, casts, [], cds, [], bk);

    expect(find(result.findings, 'cooldown_usage')?.severity).toBe('success');
  });
});

describe('analyzeCooldowns / lost casts (bench-driven)', () => {
  const cds = rulebook({ cooldowns: [{ name: 'Shadow Blades', spell_id: SHADOW_BLADES, cooldown: 120 }] }).major_cooldowns!;

  it('does not flag when player matches cohort usage rate (hold scenario)', () => {
    // Top parsers average ~0.4 uses/min (2 casts in 5 min) with stddev 0.
    // Player casts twice - no flag.
    const bk = bench({ perCd: { 'Shadow Blades': { uses_per_min: { avg: 0.4, stddev: 0, min: 0.4, max: 0.4 }, avg_uses_per_min: 0.4 } } });
    const casts = Events.cast(SHADOW_BLADES, '0:05').cast(SHADOW_BLADES, '2:30').build();

    const result = analyzeCooldowns('Rogue', 'Sub', FIGHT_START, FIVE_MIN, casts, [], cds, [], bk);

    expect(find(result.findings, 'lost_cooldown')).toBeUndefined();
  });

  it('does not flag when player is within the cohort - 1 sigma band', () => {
    // rate=0.5/min, stddev=0.2/min, fight=5min -> expected=3, floor=2
    // Player has 2 casts (= floor) -> no flag (must be below floor to fire).
    const bk = bench({ perCd: { 'Shadow Blades': { uses_per_min: { avg: 0.5, stddev: 0.2, min: 0.3, max: 0.7 }, avg_uses_per_min: 0.5 } } });
    const casts = Events.cast(SHADOW_BLADES, '0:05').cast(SHADOW_BLADES, '2:30').build();

    const result = analyzeCooldowns('Rogue', 'Sub', FIGHT_START, FIVE_MIN, casts, [], cds, [], bk);

    expect(find(result.findings, 'lost_cooldown')).toBeUndefined();
  });

  it('flags when player is genuinely below the cohort floor (lost uses)', () => {
    // rate=0.5/min, stddev=0.2/min, fight=5min -> expected=3, floor=2
    // Player has only 1 cast (below floor) -> critical.
    const bk = bench({ perCd: { 'Shadow Blades': { uses_per_min: { avg: 0.5, stddev: 0.2, min: 0.3, max: 0.7 }, avg_uses_per_min: 0.5 } } });
    const casts = Events.cast(SHADOW_BLADES, '0:05').build();

    const result = analyzeCooldowns('Rogue', 'Sub', FIGHT_START, FIVE_MIN, casts, [], cds, [], bk);

    const lost = find(result.findings, 'lost_cooldown');
    expect(lost?.severity).toBe('critical');
    expect(lost?.message).toContain('top parsers average');
  });

  it('flags zero casts as critical when cohort expects at least 1', () => {
    // expected=2, floor=2 -> zero casts -> critical
    const bk = bench({ perCd: { 'Shadow Blades': { uses_per_min: { avg: 0.4, stddev: 0, min: 0.4, max: 0.4 }, avg_uses_per_min: 0.4 } } });

    const result = analyzeCooldowns('Rogue', 'Sub', FIGHT_START, FIVE_MIN, [], [], cds, [], bk);

    const lost = find(result.findings, 'lost_cooldown');
    expect(lost?.severity).toBe('critical');
    expect(lost?.message).toContain('Top parsers average');
  });

  it('suppresses zero-cast critical on a short fight where expected rounds to 0', () => {
    // 0.15 uses/min * 1 min = 0.15 -> rounds to 0 -> no flag even though never used
    const ONE_MIN = FIGHT_START + 60_000;
    const bk = bench({ perCd: { 'Shadow Blades': { uses_per_min: { avg: 0.15, stddev: 0, min: 0.15, max: 0.15 }, avg_uses_per_min: 0.15 } } });

    const result = analyzeCooldowns('Rogue', 'Sub', FIGHT_START, ONE_MIN, [], [], cds, [], bk);

    expect(find(result.findings, 'lost_cooldown')).toBeUndefined();
  });
});

describe('analyzeCooldowns / opener delay (first cast > mean + 2 sigma)', () => {
  const cds = rulebook({ cooldowns: [{ name: 'Shadow Blades', spell_id: SHADOW_BLADES, cooldown: 180 }] }).major_cooldowns!;
  // 0.4/min * 5min = 2 expected; matches the 2 casts used in each test.
  const upm = { uses_per_min: { avg: 0.4, stddev: 0, min: 0.4, max: 0.4 }, avg_uses_per_min: 0.4 };

  it('warns when the opener is later than the top-parse mean + 2 sigma', () => {
    // bench: opener mean 3s +/- 1s -> threshold 5s. Player opens at 0:10.
    const bk = bench({ perCd: { 'Shadow Blades': { ...upm, avg_first_cast_s: 3, stddev_first_cast_s: 1 } } });
    const casts = Events.cast(SHADOW_BLADES, '0:10').cast(SHADOW_BLADES, '3:10').build();

    const result = analyzeCooldowns('Rogue', 'Sub', FIGHT_START, FIVE_MIN, casts, [], cds, [], bk);

    expect(find(result.findings, 'cooldown_delay')?.severity).toBe('warning');
  });

  it('stays quiet for an on-time opener', () => {
    const bk = bench({ perCd: { 'Shadow Blades': { ...upm, avg_first_cast_s: 3, stddev_first_cast_s: 1 } } });
    const casts = Events.cast(SHADOW_BLADES, '0:04').cast(SHADOW_BLADES, '3:04').build();

    const result = analyzeCooldowns('Rogue', 'Sub', FIGHT_START, FIVE_MIN, casts, [], cds, [], bk);

    expect(find(result.findings, 'cooldown_delay')).toBeUndefined();
  });
});

describe('analyzeCooldowns / Bloodlust alignment', () => {
  // 0.2/min * 5min = 1 expected; matches the single cast in each test.
  const bk = bench({ perCd: { 'Shadow Blades': { uses_per_min: { avg: 0.2, stddev: 0, min: 0.2, max: 0.2 }, avg_uses_per_min: 0.2 } } });

  it('marks a BL-wanting cooldown that missed the Bloodlust window as critical', () => {
    const cds = rulebook({ cooldowns: [{ name: 'Shadow Blades', spell_id: SHADOW_BLADES, cooldown: 180, align_with_bloodlust: true }] }).major_cooldowns!;
    // BL pulses at 0:05; the only Shadow Blades is at 4:00, far outside the window.
    const casts = Events.cast(SHADOW_BLADES, '4:00').build();
    const buffs = Events.start().applyBuff(BLOODLUST, '0:05').build();

    const result = analyzeCooldowns('Rogue', 'Sub', FIGHT_START, FIVE_MIN, casts, buffs, cds, [], bk);

    const align = find(result.findings, 'cooldown_alignment');
    expect(align?.severity).toBe('critical');
    expect(align?.message).toContain('missed Bloodlust');
  });

  it('does not penalise alignment for a cooldown that opts out of Bloodlust', () => {
    const cds = rulebook({ cooldowns: [{ name: 'Shadow Blades', spell_id: SHADOW_BLADES, cooldown: 180, align_with_bloodlust: false }] }).major_cooldowns!;
    const casts = Events.cast(SHADOW_BLADES, '4:00').build();
    const buffs = Events.start().applyBuff(BLOODLUST, '0:05').build();

    const result = analyzeCooldowns('Rogue', 'Sub', FIGHT_START, FIVE_MIN, casts, buffs, cds, [], bk);

    expect(find(result.findings, 'cooldown_alignment')).toBeUndefined();
  });
});

describe('analyzeCooldowns / hold suggestion', () => {
  it('suggests holding when the player casts well before the top-parse hold target', () => {
    const cds = rulebook({ cooldowns: [{ name: 'Shadow Blades', spell_id: SHADOW_BLADES, cooldown: 180 }] }).major_cooldowns!;
    // Hold target for cast #2 is ~200s +/- 10s; player fires #2 at 0:50 (way early).
    // 0.4/min * 5min = 2 expected; matches the 2 casts.
    const bk = bench({ perCd: { 'Shadow Blades': { uses_per_min: { avg: 0.4, stddev: 0, min: 0.4, max: 0.4 }, avg_uses_per_min: 0.4,
      hold_targets: { '2': { target_s: 200, stddev_s: 10, count: 8, total_samples: 10 } } } } });
    const casts = Events.cast(SHADOW_BLADES, '0:05').cast(SHADOW_BLADES, '0:50').build();

    const result = analyzeCooldowns('Rogue', 'Sub', FIGHT_START, FIVE_MIN, casts, [], cds, [], bk);

    const sugg = find(result.findings, 'hold_suggestion');
    expect(sugg?.severity).toBe('info');
    expect(sugg?.details?.remedy).toContain('Consider holding Shadow Blades');
  });
});

describe('analyzeCooldowns / cast efficiency', () => {
  it('reports efficiency below the top-parse band as a finding', () => {
    // Two casts 100s apart -> a 100s gap above the 1500ms downtime floor.
    const bk = bench({ downtimeThresholdMs: 1500, topAvgEfficiency: 90, topEfficiencyStddev: 2 });
    const casts = Events.cast(SHADOW_BLADES, '0:10').cast(SHADOW_BLADES, '1:50').build();

    const result = analyzeCooldowns('Rogue', 'Sub', FIGHT_START, FIVE_MIN, casts, [], null, [], bk);

    const eff = find(result.findings, 'cast_efficiency');
    expect(eff).toBeDefined();
    expect(eff?.severity).toBe('critical'); // far below 90% -> critical band
  });
});

describe('analyzeCooldowns / unsupported spec', () => {
  it('emits an info finding when there is no rulebook for the spec', () => {
    const result = analyzeCooldowns('Rogue', 'MysterySpec', FIGHT_START, FIVE_MIN, [], [], null, [], null);

    expect(find(result.findings, 'unsupported_spec')?.message).toContain('MysterySpec is not yet in the rulebook');
  });
});

describe('analyzeCooldowns / talent_gated', () => {
  const bk = bench({ perCd: { 'Avatar': { uses_per_min: { avg: 0.4, stddev: 0, min: 0.4, max: 0.4 }, avg_uses_per_min: 0.4 },
                               'Recklessness': { uses_per_min: { avg: 0.4, stddev: 0, min: 0.4, max: 0.4 }, avg_uses_per_min: 0.4 } } });

  it('does not flag a talent-gated cooldown with zero casts as lost', () => {
    const cds = rulebook({ cooldowns: [{ name: 'Avatar', spell_id: SHADOW_BLADES, cooldown: 90, talent_gated: true }] }).major_cooldowns!;

    const result = analyzeCooldowns('Warrior', 'Fury', FIGHT_START, FIVE_MIN, [], [], cds, [], bk);

    expect(find(result.findings, 'lost_cooldown')).toBeUndefined();
  });

  it('still flags a non-talent-gated cooldown with zero casts as lost', () => {
    const cds = rulebook({ cooldowns: [{ name: 'Recklessness', spell_id: SHADOW_BLADES, cooldown: 90 }] }).major_cooldowns!;

    const result = analyzeCooldowns('Warrior', 'Fury', FIGHT_START, FIVE_MIN, [], [], cds, [], bk);

    expect(find(result.findings, 'lost_cooldown')?.severity).toBe('critical');
  });
});
