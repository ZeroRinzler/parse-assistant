import { PerDefensiveBenchmark } from '../../../../domain/encounter/encounter.models';
import { CLOAK_OF_SHADOWS } from '../../../../../testing/spell-ids';
import { TestBed } from '@angular/core/testing';
import { WclProjectionsService } from '../../../../domain/analysis/wcl-projections-service';
import { DefensiveBench } from '../data-access/defensive-data-source';

/** Fixture events build against a fight-start of 0, so stamping is a pass-through to seconds. */
export const timed: WclProjectionsService['withRelativeS'] = (events, fightStartMs) =>
  TestBed.inject(WclProjectionsService).withRelativeS(events, fightStartMs);

export const CLOAK_META = { name: 'Cloak of Shadows', spell_id: CLOAK_OF_SHADOWS, cooldown: 120, usage_rule: 'Use on big hits', talent_gated: false };

export function defBench(overrides: Partial<PerDefensiveBenchmark> = {}): PerDefensiveBenchmark {
  return {
    sample_count: 5, used_sample_count: 5, avg_first_cast_s: 10, stddev_first_cast_s: 2, avg_gap_s: 60, stddev_gap_s: 5,
    hold_targets: {}, median_uses: 2, uses_per_min: { avg: 0.4, stddev: 0.05 },
    majority_hold: false,
    ...overrides,
  };
}

export function benchWith(overrides: Partial<DefensiveBench> = {}): DefensiveBench {
  return {
    spec: 'SubtletyRogue', encounter_id: 1, encounter_name: 'Boss', sample_count: 5,
    per_defensive_benchmarks: {}, defensive_windows: [],
    defensives: [], cd_spell_ids: {}, ability_icons: {},
    ...overrides,
  };
}

export const BOSS_HIT_SPELL_ID = 700;
export const WINDOW_REF_GAME_ID = 6666;

export function fullBench(): DefensiveBench {
  return benchWith({
    per_defensive_benchmarks: { 'Cloak of Shadows': defBench() },
    defensive_windows: [{
      time_s: 30, window_length_s: 5, dmg_avg: 1000, dmg_min: 800, dmg_max: 1200, dmg_stddev: 100,
      defensive_name: 'Cloak of Shadows', spell_id: CLOAK_OF_SHADOWS, ref_game_id: WINDOW_REF_GAME_ID, common_cds: ['Cloak of Shadows'],
      ability_breakdown: [{ spell_id: BOSS_HIT_SPELL_ID, avg_damage: 600, min_damage: 400, max_damage: 800 }],
    }],
    defensives: [CLOAK_META],
    cd_spell_ids: { 'Cloak of Shadows': CLOAK_OF_SHADOWS },
    ability_icons: { [CLOAK_OF_SHADOWS]: { icon: 'cloak', name: 'Cloak of Shadows' }, [BOSS_HIT_SPELL_ID]: { icon: 'hit', name: 'Boss Hit' } },
  });
}
