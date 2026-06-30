import { InjectionToken } from '@angular/core';
import { DataSource } from '../../../core/data-source/data-source';
import { EncounterGearStats } from '../../../core/models/encounter.models';

/**
 * The tailored, ready-to-render gear bench for one encounter, read from
 * `data/specs/{spec}/gear/{enc}.json` (a reshape of `EncounterBench.gear`). This is
 * the slice's own storage shape - the gear card needs nothing else from disk.
 *
 * The talent / trinket / enchant aggregates reuse `EncounterGearStats` (the same
 * shape the shared presentational helpers in `shared/gear/gear-comparison.ts`
 * already consume), with the bench names already baked in by ingest.
 */
export interface GearBench {
  spec: string;
  encounter_id: number;
  encounter_name: string;
  sample_count: number;
  talent_builds: EncounterGearStats['talent_builds'];
  trinkets: EncounterGearStats['trinkets'];
  enchants: EncounterGearStats['enchants'];
}

/**
 * The gear slice's data-source token. `provideDataSource` binds it to a
 * `FileDataSource<GearBench>` (production: reads the tailored file) or
 * `GearTransformService` (the dev `useLiveTransform` flag / ingestion: computes it live)
 * - both `DataSource<GearBench>`.
 */
export const GEAR_DATA_SOURCE = new InjectionToken<DataSource<GearBench>>('GEAR_DATA_SOURCE');
