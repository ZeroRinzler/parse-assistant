import { Injectable, inject } from '@angular/core';
import { DataFileApiService } from '../../../../core/data-files/data-file-api-service';
import { type Result } from '../../../../core/http/result';
import type { TopParseSelection } from '../../../../core/wcl/wcl.models';
import { BurstTransformService } from '../../burst-windows/data-access/burst-transform-service';
import { RotationTransformService } from '../../rotation/data-access/rotation-transform-service';
import { DefensiveTransformService } from '../../defensive/data-access/defensive-transform-service';
import { GearTransformService } from '../../gear/data-access/gear-transform-service';
import { MapTransformService } from '../../map/data-access/map-transform-service';
import { NorthernSkyTransformService } from '../../northern-sky/data-access/northern-sky-transform-service';

export interface SliceDescriptor {
  readonly file: string;
  readonly transform: { getBench(spec: string, encId: number, selection: TopParseSelection): Promise<Result<object>> };
  readonly write: (spec: string, encId: number, data: object) => Promise<void>;
}

/** Non-empty: the orchestrator destructures the head as the burst slice. */
type SliceRegistry = readonly [SliceDescriptor, ...SliceDescriptor[]];

export const BENCH_SLICE = 'burst';

@Injectable({ providedIn: 'root' })
export class SliceRegistryService {
  private readonly dataFile = inject(DataFileApiService);

  private bench(file: string, transform: SliceDescriptor['transform']): SliceDescriptor {
    return {
      file, transform,
      write: (spec, encId, data) => this.dataFile.writeSlice(spec, encId, file, data),
    };
  }

  // Burst leads: only its file carries the encounter signature, stamped only when every slice behind it produced data.
  readonly slices: SliceRegistry = [
    this.bench(BENCH_SLICE, inject(BurstTransformService)),
    this.bench('rotation', inject(RotationTransformService)),
    this.bench('defensive', inject(DefensiveTransformService)),
    this.bench('gear', inject(GearTransformService)),
    this.bench('positions', inject(MapTransformService)),
    this.bench('northern-sky', inject(NorthernSkyTransformService)),
  ];
}
