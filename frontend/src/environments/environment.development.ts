/**
 * Development environment (swapped in by the `development` build configuration).
 *
 * The `environmentProviders` list below binds every `*_DATA_SOURCE` token to its
 * `*TransformService`, so each slice computes its prepared data live from WCL in the browser
 * - `npm start` runs with zero ingested files. Slower (a burst render fetches the top parses
 * + their Casts/DamageDone), dev only. Production stays on the file source
 * (`environment.ts`).
 *
 * The `*TransformService` imports live HERE and nowhere in the eager production graph,
 * which is what lets a production build tree-shake the transforms out of the bundle
 * entirely.
 */
import { Provider } from '@angular/core';
import { WCL_PUBLIC_CLIENT_ID, WCL_PUBLIC_CLIENT_SECRET } from './wcl-public-client';
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
  /** Empty resolves `data/specs/` relative to `document.baseURI` (per-folder copy);
   * see `environment.ts` for the shared-copy override used by preview builds. */
  dataBaseHref: '',
  ingest: false,
  /** WCL client-credentials pair (intentionally public - see wcl-public-client.ts). */
  wclClientId: WCL_PUBLIC_CLIENT_ID,
  wclClientSecret: WCL_PUBLIC_CLIENT_SECRET,
};

/** Development data-source bindings: every slice computes its bench live via its transform. */
export const environmentProviders: Provider[] = [
  provideLiveDataSource(BURST_DATA_SOURCE, BurstTransformService),
  provideLiveDataSource(ROTATION_DATA_SOURCE, RotationTransformService),
  provideLiveDataSource(DEFENSIVE_DATA_SOURCE, DefensiveTransformService),
  provideLiveDataSource(GEAR_DATA_SOURCE, GearTransformService),
  provideLiveDataSource(MAP_DATA_SOURCE, MapTransformService),
];
