import { inject } from '@angular/core';
import { DataFileApiService } from '../../core/services/data-file-api';
import { type Result } from '../../core/result';
import type { EncounterPositions } from '../../core/models/positioning.models';
import { BurstTransformService } from '../../pages/post-raid/burst-windows/burst-transform.service';
import { RotationTransformService } from '../../pages/post-raid/rotation/rotation-transform.service';
import { DefensiveTransformService } from '../../pages/post-raid/defensive/defensive-transform.service';
import { GearTransformService } from '../../pages/post-raid/gear/gear-transform.service';
import { MapTransformService } from '../../pages/post-raid/map/map-transform.service';
import { NorthernSkyTransformService } from '../../pages/post-raid/northern-sky/northern-sky-transform.service';

export interface SliceDescriptor {
  readonly file: string;
  readonly transform: { getBench(spec: string, encId: number, partition: number | null): Promise<Result<object>> };
  readonly write: (spec: string, encId: number, data: object) => Promise<void>;
}

/** Non-empty: the orchestrator destructures the head as the burst slice. */
export type SliceRegistry = readonly [SliceDescriptor, ...SliceDescriptor[]];

// Burst leads: only its file carries the encounter signature, stamped only when every slice behind it produced data.
export function sliceRegistry(): SliceRegistry {
  const dataFile = inject(DataFileApiService);
  const bench = (file: string, transform: SliceDescriptor['transform']): SliceDescriptor => ({
    file, transform,
    write: (spec, encId, data) => dataFile.writeSlice(spec, encId, file, data),
  });
  return [
    bench('burst', inject(BurstTransformService)),
    bench('rotation', inject(RotationTransformService)),
    bench('defensive', inject(DefensiveTransformService)),
    bench('gear', inject(GearTransformService)),
    {
      file: 'positions', transform: inject(MapTransformService),
      write: (spec, encId, data) => dataFile.writePositions(spec, encId, data as EncounterPositions),
    },
    bench('northern-sky', inject(NorthernSkyTransformService)),
  ];
}
