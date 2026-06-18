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
  it('marks a cooldown that was never used as critical', () => {
    const cds = rulebook({ cooldowns: [{ name: 'Shadow Blades', spell_id: SHADOW_BLADES, cooldown: 180 }] }).major_cooldowns!;

    const result = analyzeCooldowns('Rogue', 'Sub', FIGHT_START, FIVE_MIN, [], [], cds, [], null);

    const lost = find(result.findings, 'lost_cooldown');
    expect(lost?.severity).toBe('critical');
    expect(lost?.message).toContain('was never used');
  });

  it('flags fewer casts than the 1 + floor(dur/cd) expectation', () => {
    // 5:00 fight, 180s cd -> expected 1 + floor(300/180) = 2. Only one cast.
    const cds = rulebook({ cooldowns: [{ name: 'Shadow Blades', spell_id: SHADOW_BLADES, cooldown: 180 }] }).major_cooldowns!;
    const casts = Events.cast(SHADOW_BLADES, '0:05').build();

    const result = analyzeCooldowns('Rogue', 'Sub', FIGHT_START, FIVE_MIN, casts, [], cds, [], null);

    expect(find(result.findings, 'lost_cooldown')?.message).toContain('1 of 2 expected casts');
  });

  it('emits a success finding when usage meets expectation with no issues', () => {
    const cds = rulebook({ cooldowns: [{ name: 'Shadow Blades', spell_id: SHADOW_BLADES, cooldown: 180 }] }).major_cooldowns!;
    const casts = Events.cast(SHADOW_BLADES, '0:05').cast(SHADOW_BLADES, '3:05').build();

    const result = analyzeCooldowns('Rogue', 'Sub', FIGHT_START, FIVE_MIN, casts, [], cds, [], null);

    expect(find(result.findings, 'cooldown_usage')?.severity).toBe('success');
  });
});

describe('analyzeCooldowns / opener delay (first cast > mean + 2 sigma)', () => {
  const cds = rulebook({ cooldowns: [{ name: 'Shadow Blades', spell_id: SHADOW_BLADES, cooldown: 180 }] }).major_cooldowns!;

  it('warns when the opener is later than the top-parse mean + 2 sigma', () => {
    // bench: opener mean 3s +/- 1s -> threshold 5s. Player opens at 0:10.
    const bk = bench({ perCd: { 'Shadow Blades': { avg_first_cast_s: 3, stddev_first_cast_s: 1 } } });
    const casts = Events.cast(SHADOW_BLADES, '0:10').cast(SHADOW_BLADES, '3:10').build();

    const result = analyzeCooldowns('Rogue', 'Sub', FIGHT_START, FIVE_MIN, casts, [], cds, [], bk);

    expect(find(result.findings, 'cooldown_delay')?.severity).toBe('warning');
  });

  it('stays quiet for an on-time opener', () => {
    const bk = bench({ perCd: { 'Shadow Blades': { avg_first_cast_s: 3, stddev_first_cast_s: 1 } } });
    const casts = Events.cast(SHADOW_BLADES, '0:04').cast(SHADOW_BLADES, '3:04').build();

    const result = analyzeCooldowns('Rogue', 'Sub', FIGHT_START, FIVE_MIN, casts, [], cds, [], bk);

    expect(find(result.findings, 'cooldown_delay')).toBeUndefined();
  });
});

describe('analyzeCooldowns / Bloodlust alignment', () => {
  it('marks a BL-wanting cooldown that missed the Bloodlust window as critical', () => {
    const cds = rulebook({ cooldowns: [{ name: 'Shadow Blades', spell_id: SHADOW_BLADES, cooldown: 180, align_with_bloodlust: true }] }).major_cooldowns!;
    // BL pulses at 0:05; the only Shadow Blades is at 4:00, far outside the window.
    const casts = Events.cast(SHADOW_BLADES, '4:00').build();
    const buffs = Events.start().applyBuff(BLOODLUST, '0:05').build();

    const result = analyzeCooldowns('Rogue', 'Sub', FIGHT_START, FIVE_MIN, casts, buffs, cds, [], null);

    const align = find(result.findings, 'cooldown_alignment');
    expect(align?.severity).toBe('critical');
    expect(align?.message).toContain('missed Bloodlust');
  });

  it('does not penalise alignment for a cooldown that opts out of Bloodlust', () => {
    const cds = rulebook({ cooldowns: [{ name: 'Shadow Blades', spell_id: SHADOW_BLADES, cooldown: 180, align_with_bloodlust: false }] }).major_cooldowns!;
    const casts = Events.cast(SHADOW_BLADES, '4:00').build();
    const buffs = Events.start().applyBuff(BLOODLUST, '0:05').build();

    const result = analyzeCooldowns('Rogue', 'Sub', FIGHT_START, FIVE_MIN, casts, buffs, cds, [], null);

    expect(find(result.findings, 'cooldown_alignment')).toBeUndefined();
  });
});

describe('analyzeCooldowns / hold suggestion', () => {
  it('suggests holding when the player casts well before the top-parse hold target', () => {
    const cds = rulebook({ cooldowns: [{ name: 'Shadow Blades', spell_id: SHADOW_BLADES, cooldown: 180 }] }).major_cooldowns!;
    // Hold target for cast #2 is ~200s +/- 10s; player fires #2 at 0:50 (way early).
    const bk = bench({ perCd: { 'Shadow Blades': { hold_targets: { '2': { target_s: 200, stddev_s: 10, count: 8, total_samples: 10 } } } } });
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
