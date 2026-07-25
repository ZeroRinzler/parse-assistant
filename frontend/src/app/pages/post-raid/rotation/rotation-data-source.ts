import { InjectionToken } from '@angular/core';
import { DataSource } from '../../../core/data-source/data-source';
import { PerCdBenchmark } from '../../../core/models/encounter.models';
import { RulebookCooldown, RulebookRule } from '../../../core/models/rulebook.models';

/**
 * The tailored, ready-to-render rotation bench for one encounter, read from
 * `data/specs/{spec}/rotation/{enc}.json` (a reshape of the generic bench +
 * rulebook). This is the slice's own storage shape - the rotation card and the
 * pre-fight cooldown plan need nothing else from disk.
 *
 * It carries everything the offensive analysis needs: the per-cd thresholds
 * (`per_cd_benchmarks`), the cooldown metadata + rules used to evaluate findings,
 * a name -> spell-id map, and the baked icon/name per spell id so `wl-game-icon`
 * renders without an external icon source on pages that have no report context.
 */
export interface RotationBench {
  spec: string;
  encounter_id: number;
  encounter_name: string;
  sample_count: number;
  avg_duration_s: number;
  downtime_threshold_ms: number;
  top_avg_efficiency: number;
  top_efficiency_stddev: number;
  /** Per-cooldown statistical benchmarks (first cast, gaps, BL offset, holds, uses/min). */
  per_cd_benchmarks: Record<string, PerCdBenchmark>;
  /** Rulebook major cooldown metadata needed to drive the findings + plan. */
  major_cooldowns: RulebookCooldown[];
  /** Rulebook rotation rules with machine-readable conditions. */
  rules: RulebookRule[];
  /** Cooldown name -> spell id, for header / row icons. */
  cd_spell_ids: Record<string, number>;
  /** Baked spell-id -> display icon + name (from ingest ability metadata). */
  ability_icons: Record<number, { icon: string; name: string }>;
}

/**
 * The rotation slice's data-source token. `provideDataSource` binds it to a
 * `FileDataSource<RotationBench>` (production: reads the tailored file) or
 * `RotationTransformService` (the development and ingest environments: computes it live)
 * - both `DataSource<RotationBench>`.
 */
export const ROTATION_DATA_SOURCE = new InjectionToken<DataSource<RotationBench>>('ROTATION_DATA_SOURCE');
