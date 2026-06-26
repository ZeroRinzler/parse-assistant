import { InjectionToken } from '@angular/core';
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
 * A source of gear bench data: the production file reader (`GearDataFileService`)
 * or the dev-flag live transform (`GearTransformService`). The two implement the
 * same contract and are swapped by `provideDataSource` per `environment.useLiveTransform`.
 */
export interface GearDataSource {
  getGearBench(spec: string, encounterId: number): Promise<GearBench | null>;
}

export const GEAR_DATA_SOURCE = new InjectionToken<GearDataSource>('GEAR_DATA_SOURCE');
