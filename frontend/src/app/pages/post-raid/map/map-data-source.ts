import { InjectionToken } from '@angular/core';
import { EncounterPositions } from '../../../core/models/positioning.models';

/**
 * The tailored, ready-to-draw position bench for one encounter, read from
 * `data/specs/{spec}/positions/{enc}.json`. The map slice needs nothing else
 * from disk: the file already holds the top-parse player + enemy timelines
 * (raw WCL units that the slice's pure fns scale to yards/radians at draw time).
 *
 * It is simply `EncounterPositions` today; the alias keeps the slice's storage
 * shape named like the other slices' bench types (e.g. `BurstBench`) so a future
 * reshape stays local to this file.
 */
export type MapData = EncounterPositions;

/**
 * A source of map position data: the production file reader (`MapDataFileService`)
 * or the dev-flag live transform (`MapTransformService`). The two implement the
 * same contract and are swapped by `provideDataSource` per
 * `environment.useLiveTransform`.
 */
export interface MapDataSource {
  getMapData(spec: string, encounterId: number): Promise<MapData | null>;
}

export const MAP_DATA_SOURCE = new InjectionToken<MapDataSource>('MAP_DATA_SOURCE');
