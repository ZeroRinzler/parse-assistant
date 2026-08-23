import { assert, describe, it, expect } from 'vitest';
import { SHADOW_BLADES, SECRET_TECHNIQUE, VANISH } from '../../../../../testing/spell-ids';
import { RotationFeatureService } from './rotation-feature-service';
import { cdBench } from './rotation-harness';
import { TestBed } from '@angular/core/testing';
import { WCL_TRANSPORT } from '../../../../core/wcl/wcl-transport';
import { DATA_FILE_TRANSPORT } from '../../../../core/data-files/data-file-transport';
import { ROTATION_DATA_SOURCE } from '../data-access/rotation-data-source';

TestBed.configureTestingModule({ providers: [
  { provide: WCL_TRANSPORT, useValue: {} },
  { provide: DATA_FILE_TRANSPORT, useValue: { readJson: () => new Promise(() => undefined) } },
  { provide: ROTATION_DATA_SOURCE, useValue: {} },
] });
const svc = TestBed.inject(RotationFeatureService);
TestBed.resetTestingModule();

describe('buildCdPlan', () => {
  const abilities = { [VANISH]: { icon: 'vanish', name: 'Vanish' }, [SHADOW_BLADES]: { icon: 'sb', name: 'Shadow Blades' } };
  it('orders by opener priority and surfaces holds for majority-hold cds', () => {
    const cooldowns = [
      { name: 'Vanish', spell_id: VANISH, cooldown: 120, opener_priority: 2, usage_rule: 'late' },
      { name: 'Shadow Blades', spell_id: SHADOW_BLADES, cooldown: 90, opener_priority: 1, usage_rule: 'open' },
    ];
    const benchmarks = {
      'Shadow Blades': cdBench({ majority_hold: true, hold_targets: { '2': { target_s: 100, delay_s: 10, band_s: 5, effective_cd_s: 90, count: 4, total_samples: 5 } } }),
      'Vanish': cdBench({ avg_first_cast_s: 20 }),
    };
    const plan = svc['buildCdPlan'](cooldowns, benchmarks, abilities);
    expect(plan.map(p => p.name)).toEqual(['Shadow Blades', 'Vanish']);
    assert.exists(plan[0]);
    expect(plan[0].holds).toEqual([{ castIndex: 2, targetS: 100 }]);
    assert.exists(plan[0]);
    expect(plan[0].bloodlust).toBe(true);
    assert.exists(plan[0]);
    expect(plan[0].bloodlustPct).toBe(100);
  });

  it('drives the Bloodlust badge from bl_pct, not the rulebook flag', () => {
    const cooldowns = [
      { name: 'Aligned', spell_id: SHADOW_BLADES, cooldown: 90 },
      { name: 'Unaligned', spell_id: VANISH, cooldown: 120 },
    ];
    const benchmarks = {
      Aligned: cdBench({ bl_pct: 50 }),    // flag false, but data says aligned -> badge on (50 boundary)
      Unaligned: cdBench({ bl_pct: 49 }),  // flag true, but data says not -> badge off
    };
    const plan = svc['buildCdPlan'](cooldowns, benchmarks, abilities);
    const aligned = plan.find(p => p.name === 'Aligned');
    assert.exists(aligned);
    const unaligned = plan.find(p => p.name === 'Unaligned');
    assert.exists(unaligned);
    expect(aligned.bloodlust).toBe(true);
    expect(aligned.bloodlustPct).toBe(50);
    expect(unaligned.bloodlust).toBe(false);
    expect(unaligned.bloodlustPct).toBeNull();
  });

  it('falls back to an empty icon for a cooldown whose spell id is not in the ability map', () => {
    // SECRET_TECHNIQUE is deliberately absent from `abilities`, so the guarded lookup must not throw.
    const UNMAPPED_SPELL_ID = SECRET_TECHNIQUE;
    const plan = svc['buildCdPlan']([{ name: 'Unmapped', spell_id: UNMAPPED_SPELL_ID, cooldown: 60 }], {}, abilities);
    assert.exists(plan[0]);
    expect(plan[0].spellId).toBe(UNMAPPED_SPELL_ID);
    assert.exists(plan[0]);
    expect(plan[0].icon).toBe('');
  });

  it('renders the empty state for typical uses when no top parse ever used the cd', () => {
    // used_sample_count 0 -> the transform emits avg_first_cast_s 0, a no-data sentinel, not a 0:00 open.
    const TOTAL_SAMPLED = 5;
    const unused = cdBench({
      sample_count: TOTAL_SAMPLED, used_sample_count: 0, avg_first_cast_s: 0, median_uses: 0,
      uses_per_min: { avg: 0, stddev: 0 },
    });
    const plan = svc['buildCdPlan']([{ name: 'Shadow Blades', spell_id: SHADOW_BLADES, cooldown: 90 }], { 'Shadow Blades': unused }, abilities);
    assert.exists(plan[0]);
    expect(plan[0].firstCastS).toBeNull();
    assert.exists(plan[0]);
    expect(plan[0].usesPerMin).toBeNull();
    // No sampled parse ever used it, so the row renders the honest empty state rather than a 0.
    assert.exists(plan[0]);
    expect(plan[0].typicalUses).toBeNull();
    // The adoption counts reaching the template are the raw sample counts, not a precomputed "0/5" string.
    assert.exists(plan[0]);
    expect(plan[0].usedSampleCount).toBe(0);
    assert.exists(plan[0]);
    expect(plan[0].sampleCount).toBe(TOTAL_SAMPLED);
  });

  it('nulls the per-use fields when only a minority of top parses use the cd (use-share gate)', () => {
    // 2/10 = 20%, below the majority gate, so even a real avg_first_cast_s is unrepresentative of the plan.
    const TOTAL_SAMPLED = 10;
    const MINORITY_USERS = 2;
    const MEDIAN_USES = 3;
    const rare = cdBench({ sample_count: TOTAL_SAMPLED, used_sample_count: MINORITY_USERS, avg_first_cast_s: 20, median_uses: MEDIAN_USES });
    const plan = svc['buildCdPlan']([{ name: 'Shadow Blades', spell_id: SHADOW_BLADES, cooldown: 90 }], { 'Shadow Blades': rare }, abilities);
    assert.exists(plan[0]);
    expect(plan[0].firstCastS).toBeNull();
    assert.exists(plan[0]);
    expect(plan[0].usesPerMin).toBeNull();
    // Typical uses only gates on any adoption at all, not the majority share, so a minority still surfaces it.
    assert.exists(plan[0]);
    expect(plan[0].typicalUses).toBe(MEDIAN_USES);
    assert.exists(plan[0]);
    expect(plan[0].usedSampleCount).toBe(MINORITY_USERS);
    assert.exists(plan[0]);
    expect(plan[0].sampleCount).toBe(TOTAL_SAMPLED);
  });

  it('keeps the per-use fields when a majority of top parses use the cd', () => {
    // Default cdBench: used_sample_count 5 of sample_count 5 -> full use share, so the gate passes.
    const FIRST_CAST_S = 8;
    const USES_PER_MIN = 1.2;
    const used = cdBench({ avg_first_cast_s: FIRST_CAST_S, uses_per_min: { avg: USES_PER_MIN, stddev: 0.1 } });
    const plan = svc['buildCdPlan']([{ name: 'Shadow Blades', spell_id: SHADOW_BLADES, cooldown: 90 }], { 'Shadow Blades': used }, abilities);
    assert.exists(plan[0]);
    expect(plan[0].firstCastS).toBe(FIRST_CAST_S);
    assert.exists(plan[0]);
    expect(plan[0].usesPerMin).toBe(USES_PER_MIN);
  });
});
