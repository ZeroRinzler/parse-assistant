import { inject } from '@angular/core';
import { DataFileApiService } from '../../core/services/data-file-api';
import { type Result } from '../../core/result';
import type { TopParseSelection } from '../../core/models/wcl.models';
import { BurstTransformService } from '../../pages/post-raid/burst-windows/burst-transform.service';
import { RotationTransformService } from '../../pages/post-raid/rotation/rotation-transform.service';
import { DefensiveTransformService } from '../../pages/post-raid/defensive/defensive-transform.service';
import { GearTransformService } from '../../pages/post-raid/gear/gear-transform.service';
import { MapTransformService } from '../../pages/post-raid/map/map-transform.service';
import { NorthernSkyTransformService } from '../../pages/post-raid/northern-sky/northern-sky-transform.service';

export interface SliceDescriptor {
  readonly file: string;
  readonly transform: { getBench(spec: string, encId: number, selection: TopParseSelection): Promise<Result<object>> };
  readonly write: (spec: string, encId: number, data: object) => Promise<void>;
}

/** Non-empty: the orchestrator destructures the head as the burst slice. */
type SliceRegistry = readonly [SliceDescriptor, ...SliceDescriptor[]];

export const BENCH_SLICE = 'burst';

// Burst leads: only its file carries the encounter signature, stamped only when every slice behind it produced data.
export function sliceRegistry(): SliceRegistry {
  const dataFile = inject(DataFileApiService);
  const bench = (file: string, transform: SliceDescriptor['transform']): SliceDescriptor => ({
    file, transform,
    write: (spec, encId, data) => dataFile.writeSlice(spec, encId, file, data),
  });
  return [
    bench(BENCH_SLICE, inject(BurstTransformService)),
    bench('rotation', inject(RotationTransformService)),
    bench('defensive', inject(DefensiveTransformService)),
    bench('gear', inject(GearTransformService)),
    bench('positions', inject(MapTransformService)),
    bench('northern-sky', inject(NorthernSkyTransformService)),
  ];
}
