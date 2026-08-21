import { PerDefensiveBenchmark } from '../../../core/models/encounter.models';
import { CLOAK_OF_SHADOWS } from '../../../../testing/spell-ids';
import { withRelativeS } from '../../../shared/analysis/wcl-projections';

/** Fixture events build against a fight-start of 0, so stamping is a pass-through to seconds. */
export const timed = withRelativeS;

export const CLOAK_META = { name: 'Cloak of Shadows', spell_id: CLOAK_OF_SHADOWS, cooldown: 120, usage_rule: 'Use on big hits', talent_gated: false };

export function defBench(overrides: Partial<PerDefensiveBenchmark> = {}): PerDefensiveBenchmark {
  return {
    sample_count: 5, used_sample_count: 5, avg_first_cast_s: 10, stddev_first_cast_s: 2, avg_gap_s: 60, stddev_gap_s: 5,
    hold_targets: {}, median_uses: 2, uses_per_min: { avg: 0.4, stddev: 0.05 },
    majority_hold: false,
    ...overrides,
  };
}
