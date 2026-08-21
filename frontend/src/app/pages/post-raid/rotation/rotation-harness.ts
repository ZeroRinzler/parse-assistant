import { PerCdBenchmark } from '../../../core/models/encounter.models';
import { SHADOW_BLADES } from '../../../../testing/spell-ids';
import { RotationBench } from './rotation-data-source';

export function cdBench(over: Partial<PerCdBenchmark> = {}): PerCdBenchmark {
  return {
    avg_first_cast_s: 5, stddev_first_cast_s: 2,
    avg_gap_s: 90, stddev_gap_s: 5,
    avg_bl_offset_s: 0, stddev_bl_offset_s: 2,
    median_uses: 2,
    uses_per_min: { avg: 1, stddev: 0.1 },
    bl_pct: 100, majority_hold: false, hold_targets: {}, sample_count: 5, used_sample_count: 5,
    ...over,
  };
}

export function bench(over: Partial<RotationBench> = {}): RotationBench {
  return {
    spec: 'SubtletyRogue', encounter_id: 1, encounter_name: 'Boss', sample_count: 5,
    downtime_threshold_s: 1.5, top_avg_efficiency: 90, top_efficiency_stddev: 3,
    per_cd_benchmarks: { 'Shadow Blades': cdBench() },
    major_cooldowns: [{ name: 'Shadow Blades', spell_id: SHADOW_BLADES, cooldown: 90 }],
    rules: [],
    cd_spell_ids: { 'Shadow Blades': SHADOW_BLADES },
    ability_icons: { [SHADOW_BLADES]: { icon: 'sb', name: 'Shadow Blades' } },
    ...over,
  };
}
