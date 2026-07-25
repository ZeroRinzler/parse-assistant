import { InjectionToken } from '@angular/core';
import { DataSource } from '../../../core/data-source/data-source';
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
 * The map slice's data-source token. `provideDataSource` binds it to a
 * `FileDataSource<MapData>` for the `positions` file (production) or `MapTransformService`
 * (the development and ingest environments: computes it live) - both
 * `DataSource<MapData>`.
 */
export const MAP_DATA_SOURCE = new InjectionToken<DataSource<MapData>>('MAP_DATA_SOURCE');
