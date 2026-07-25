import { InjectionToken } from '@angular/core';
import { DataSource } from '../../../core/data-source/data-source';
import { BurstWindow } from '../../../core/models/analysis.models';

/**
 * The tailored, ready-to-render burst bench for one encounter, read from
 * `data/specs/{spec}/burst/{enc}.json` (a reshape of the generic bench). This is
 * the slice's own storage shape - the burst card needs nothing else from disk.
 */
export interface BurstBench {
  spec: string;
  encounter_id: number;
  encounter_name: string;
  sample_count: number;
  /** Clustered top-parse burst windows (the same shape the worker used to emit). */
  windows: BurstWindow[];
  /** Cooldown / defensive name -> spell id, for the window header icons. */
  cd_spell_ids: Record<string, number>;
  /**
   * Baked spell-id -> {icon, name}, complete over every cd_spell_ids id and every
   * window ability so `wl-game-icon` renders without a report on `/pre`.
   */
  ability_icons: Record<number, { icon: string; name: string }>;
}

/**
 * The burst slice's data-source token. `provideDataSource` binds it to a
 * `FileDataSource<BurstBench>` (production: reads the tailored file) or
 * `BurstTransformService` (the development and ingest environments: computes it live)
 * - both `DataSource<BurstBench>`.
 */
export const BURST_DATA_SOURCE = new InjectionToken<DataSource<BurstBench>>('BURST_DATA_SOURCE');
