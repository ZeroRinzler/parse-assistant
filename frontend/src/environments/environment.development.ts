/**
 * Development environment (swapped in by the `development` build configuration).
 *
 * `useLiveTransform: true` binds every `*_DATA_SOURCE` token (see `dataSourceProviders`
 * below) to its `*TransformService`, so each slice computes its prepared data live from WCL
 * in the browser - `npm start` runs with zero ingested files. Slower (a burst render
 * fetches the top parses + their Casts/DamageDone), dev only. Production stays on the file
 * source (`environment.ts`).
 *
 * The `*TransformService` imports live HERE and nowhere in the eager production graph,
 * which is what lets a production build tree-shake the transforms out of the bundle
 * entirely.
 */
import { Provider } from '@angular/core';
import { provideLiveDataSource } from '../app/core/data-source/provide-data-source';
import { BURST_DATA_SOURCE } from '../app/pages/post-raid/burst-windows/burst-data-source';
import { BurstTransformService } from '../app/pages/post-raid/burst-windows/burst-transform.service';
import { ROTATION_DATA_SOURCE } from '../app/pages/post-raid/rotation/rotation-data-source';
import { RotationTransformService } from '../app/pages/post-raid/rotation/rotation-transform.service';
import { DEFENSIVE_DATA_SOURCE } from '../app/pages/post-raid/defensive/defensive-data-source';
import { DefensiveTransformService } from '../app/pages/post-raid/defensive/defensive-transform.service';
import { GEAR_DATA_SOURCE } from '../app/pages/post-raid/gear/gear-data-source';
import { GearTransformService } from '../app/pages/post-raid/gear/gear-transform.service';
import { MAP_DATA_SOURCE } from '../app/pages/post-raid/map/map-data-source';
import { MapTransformService } from '../app/pages/post-raid/map/map-transform.service';

export const environment = {
  useLiveTransform: true,
  /** Empty resolves `data/specs/` relative to `document.baseURI` (per-folder copy);
   * see `environment.ts` for the shared-copy override used by preview builds. */
  dataBaseHref: '',
};

/** Development data-source bindings: every slice computes its bench live via its transform. */
export const dataSourceProviders: Provider[] = [
  provideLiveDataSource(BURST_DATA_SOURCE, BurstTransformService),
  provideLiveDataSource(ROTATION_DATA_SOURCE, RotationTransformService),
  provideLiveDataSource(DEFENSIVE_DATA_SOURCE, DefensiveTransformService),
  provideLiveDataSource(GEAR_DATA_SOURCE, GearTransformService),
  provideLiveDataSource(MAP_DATA_SOURCE, MapTransformService),
];
