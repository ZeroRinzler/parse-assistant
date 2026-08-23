import { assert, describe, it, expect } from 'vitest';
import { DefensiveFeatureService } from './defensive-feature-service';
import { CLOAK_OF_SHADOWS } from '../../../../../testing/spell-ids';
import { CLOAK_META, benchWith, defBench } from './defensive-harness';
import { TestBed } from '@angular/core/testing';
import { WCL_TRANSPORT } from '../../../../core/wcl/wcl-transport';
import { DATA_FILE_TRANSPORT } from '../../../../core/data-files/data-file-transport';
import { DEFENSIVE_DATA_SOURCE } from '../data-access/defensive-data-source';

TestBed.configureTestingModule({ providers: [
  { provide: WCL_TRANSPORT, useValue: {} },
  { provide: DATA_FILE_TRANSPORT, useValue: { readJson: () => new Promise(() => undefined) } },
  { provide: DEFENSIVE_DATA_SOURCE, useValue: {} },
] });
const svc = TestBed.inject(DefensiveFeatureService);
TestBed.resetTestingModule();

describe('buildDefensivePlanRows', () => {
  it('returns [] when the bench is null or has no defensives', () => {
    expect(svc['buildDefensivePlanRows'](null)).toEqual([]);
    expect(svc['buildDefensivePlanRows'](benchWith({}))).toEqual([]);
  });

  it('builds plan rows with window times, typical uses and the adoption counts', () => {
    const bench = benchWith({
      defensives: [{ name: 'Cloak of Shadows', spell_id: CLOAK_OF_SHADOWS, cooldown: 120, usage_rule: 'Use it', talent_gated: false }],
      ability_icons: { [CLOAK_OF_SHADOWS]: { icon: 'cloak', name: 'Cloak of Shadows' } },
      per_defensive_benchmarks: {
        'Cloak of Shadows': defBench({ avg_first_cast_s: 12, avg_gap_s: null, stddev_gap_s: null, median_uses: 2, sample_count: 5, used_sample_count: 5 }),
      },
      defensive_windows: [{ time_s: 30, window_length_s: 5, dmg_avg: 0, dmg_min: 0, dmg_max: 0, dmg_stddev: 0, defensive_name: 'Cloak of Shadows', common_cds: ['Cloak of Shadows'], ability_breakdown: [] }],
    });
    const rows = svc['buildDefensivePlanRows'](bench);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: 'Cloak of Shadows', spellId: CLOAK_OF_SHADOWS, icon: 'cloak',
      // The adoption counts reaching the row are the raw sample counts, not a precomputed "5/5" string.
      typicalUses: 2, usedSampleCount: 5, sampleCount: 5,
      firstCastS: 12, windowsS: [30], rule: 'Use it',
    });
  });

  it('falls back to an empty icon for a defensive whose spell id is not in the ability map', () => {
    // CLOAK_OF_SHADOWS is intentionally absent from ability_icons, so the guarded lookup must not throw.
    const bench = benchWith({
      defensives: [{ name: 'Cloak of Shadows', spell_id: CLOAK_OF_SHADOWS, cooldown: 120, usage_rule: 'Use it', talent_gated: false }],
      ability_icons: {},
    });
    const rows = svc['buildDefensivePlanRows'](bench);
    assert.exists(rows[0]);
    expect(rows[0].spellId).toBe(CLOAK_OF_SHADOWS);
    assert.exists(rows[0]);
    expect(rows[0].icon).toBe('');
  });

  it('renders the empty state for typical uses when no top parse ever used the defensive', () => {
    const TOTAL_SAMPLED = 5;
    const bench = benchWith({
      defensives: [CLOAK_META],
      ability_icons: { [CLOAK_OF_SHADOWS]: { icon: 'cloak', name: 'Cloak of Shadows' } },
      per_defensive_benchmarks: {
        'Cloak of Shadows': defBench({ sample_count: TOTAL_SAMPLED, used_sample_count: 0, avg_first_cast_s: 0, median_uses: 0 }),
      },
    });
    const rows = svc['buildDefensivePlanRows'](bench);
    // No sampled parse ever used it, so the row renders the honest empty state rather than a 0.
    assert.exists(rows[0]);
    expect(rows[0].typicalUses).toBeNull();
    assert.exists(rows[0]);
    expect(rows[0].firstCastS).toBeNull();
    assert.exists(rows[0]);
    expect(rows[0].usedSampleCount).toBe(0);
    assert.exists(rows[0]);
    expect(rows[0].sampleCount).toBe(TOTAL_SAMPLED);
  });

  it('withholds first-cast when only a minority of top parses used the defensive (use-share gate)', () => {
    // 4/10 = 40%, below the 50% majority gate, so a real avg_first_cast_s is unrepresentative of the plan.
    const TOTAL_SAMPLED = 10;
    const MINORITY_USERS = 4;
    const MEDIAN_USES = 3;
    const bench = benchWith({
      defensives: [CLOAK_META],
      ability_icons: { [CLOAK_OF_SHADOWS]: { icon: 'cloak', name: 'Cloak of Shadows' } },
      per_defensive_benchmarks: {
        'Cloak of Shadows': defBench({ sample_count: TOTAL_SAMPLED, used_sample_count: MINORITY_USERS, avg_first_cast_s: 12, median_uses: MEDIAN_USES }),
      },
    });
    const rows = svc['buildDefensivePlanRows'](bench);
    assert.exists(rows[0]);
    expect(rows[0].firstCastS).toBeNull();
    // Typical uses only gates on any adoption at all, not the majority share, so a minority still surfaces it.
    assert.exists(rows[0]);
    expect(rows[0].typicalUses).toBe(MEDIAN_USES);
    assert.exists(rows[0]);
    expect(rows[0].usedSampleCount).toBe(MINORITY_USERS);
    assert.exists(rows[0]);
    expect(rows[0].sampleCount).toBe(TOTAL_SAMPLED);
  });

  it('shows first-cast exactly at the majority-share boundary', () => {
    // 5/10 = 50%, the inclusive boundary - matches the >= majority gate the rotation plan uses.
    const TOTAL_SAMPLED = 10;
    const MAJORITY_USERS = 5;
    const FIRST_CAST_S = 12;
    const bench = benchWith({
      defensives: [CLOAK_META],
      ability_icons: { [CLOAK_OF_SHADOWS]: { icon: 'cloak', name: 'Cloak of Shadows' } },
      per_defensive_benchmarks: {
        'Cloak of Shadows': defBench({ sample_count: TOTAL_SAMPLED, used_sample_count: MAJORITY_USERS, avg_first_cast_s: FIRST_CAST_S }),
      },
    });
    const rows = svc['buildDefensivePlanRows'](bench);
    assert.exists(rows[0]);
    expect(rows[0].firstCastS).toBe(FIRST_CAST_S);
  });
});
