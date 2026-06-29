/**
 * Boots a headless Angular environment under `tsx` so the ingestion can run the very
 * same `*TransformService`s the browser does. apollo-angular does not run headless, so
 * the WCL transport is the Node fetch one; everything above it (WclApiService, the
 * transforms, DataFileApiService) is the shared Angular code. jsdom + TestBed is the
 * supported way to get an Angular injector without a browser.
 *
 * IMPORTANT: every Angular-touching module (and the node transports, which import the
 * `@angular/core` InjectionToken transitively) is loaded via DYNAMIC import INSIDE
 * `bootstrapIngestRuntime`, after jsdom + `@angular/compiler` are in place. The package
 * is CJS while `@angular/core` is ESM; mixing a static import (CJS-interop instance)
 * with a dynamic import (native-ESM instance) would load TWO `@angular/core` states and
 * `inject()` would fail with NG0203. Only jsdom/node + type-only imports are static.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { JSDOM } from 'jsdom';
import type { WclApiService } from '../../src/app/core/services/wcl-api.ts';
import type { DataFileApiService } from '../../src/app/core/services/data-file-api.ts';
import type { BurstTransformService } from '../../src/app/pages/post-raid/burst-windows/burst-transform.service.ts';
import type { RotationTransformService } from '../../src/app/pages/post-raid/rotation/rotation-transform.service.ts';
import type { DefensiveTransformService } from '../../src/app/pages/post-raid/defensive/defensive-transform.service.ts';
import type { GearTransformService } from '../../src/app/pages/post-raid/gear/gear-transform.service.ts';
import type { MapTransformService } from '../../src/app/pages/post-raid/map/map-transform.service.ts';

const __dirname_ = path.dirname(fileURLToPath(import.meta.url));
/** `frontend/public/data/specs` - the data root the runtime serves and ingestion writes. */
export const DATA_SPECS_DIR = path.resolve(__dirname_, '..', '..', 'public', 'data', 'specs');

export interface IngestRuntime {
  wclApi: WclApiService;
  dataFile: DataFileApiService;
  transforms: {
    burst: BurstTransformService;
    rotation: RotationTransformService;
    defensive: DefensiveTransformService;
    gear: GearTransformService;
    map: MapTransformService;
  };
  /** Drop the WCL in-process read cache (call between encounters to bound memory). */
  clearWclCache(): void;
  /** Return + clear the report codes that hit a permission-denied error since the last call. */
  takeInaccessibleReportCodes(): string[];
}

let booted: IngestRuntime | null = null;

export async function bootstrapIngestRuntime(dataDir: string = DATA_SPECS_DIR): Promise<IngestRuntime> {
  if (booted) return booted;

  // 1. jsdom globals BEFORE Angular loads.
  const dom = new JSDOM('<!doctype html><html><head><base href="http://localhost/"></head><body></body></html>', { url: 'http://localhost/' });
  const setGlobal = (name: string, value: unknown): void => {
    try { (globalThis as Record<string, unknown>)[name] = value; }
    catch { try { Object.defineProperty(globalThis, name, { value, configurable: true }); } catch { /* read-only */ } }
  };
  setGlobal('window', dom.window);
  setGlobal('document', dom.window.document);
  setGlobal('HTMLElement', dom.window.HTMLElement);
  setGlobal('Node', dom.window.Node);

  // 2. The JIT compiler first (so source @Injectable classes compile at runtime), then
  //    the Angular test env. All dynamic so they share ONE native-ESM @angular/core.
  await import('@angular/compiler');
  const { getTestBed, TestBed } = await import('@angular/core/testing');
  const { BrowserTestingModule, platformBrowserTesting } = await import('@angular/platform-browser/testing');
  const { provideZonelessChangeDetection, EnvironmentInjector, runInInjectionContext } = await import('@angular/core');
  const { provideHttpClient, withFetch } = await import('@angular/common/http');

  // 3. The tokens + node transports + the shared services - also dynamic (single core).
  const { WCL_TRANSPORT, WCL_INGEST_MODE } = await import('../../src/app/core/services/wcl-transport.ts');
  const { DATA_FILE_TRANSPORT } = await import('../../src/app/core/services/data-file-transport.ts');
  const { FetchWclTransport } = await import('./node-wcl-transport.ts');
  const { FsDataFileTransport } = await import('./node-data-file-transport.ts');
  const { WclApiService: WclApi } = await import('../../src/app/core/services/wcl-api.ts');
  const { DataFileApiService: DataFileApi } = await import('../../src/app/core/services/data-file-api.ts');
  const { BurstTransformService: Burst } = await import('../../src/app/pages/post-raid/burst-windows/burst-transform.service.ts');
  const { RotationTransformService: Rotation } = await import('../../src/app/pages/post-raid/rotation/rotation-transform.service.ts');
  const { DefensiveTransformService: Defensive } = await import('../../src/app/pages/post-raid/defensive/defensive-transform.service.ts');
  const { GearTransformService: Gear } = await import('../../src/app/pages/post-raid/gear/gear-transform.service.ts');
  const { MapTransformService: MapT } = await import('../../src/app/pages/post-raid/map/map-transform.service.ts');

  if (!(getTestBed() as { platform?: unknown }).platform) {
    getTestBed().initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  }
  const wclTransport = new FetchWclTransport();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(withFetch()),
      { provide: WCL_TRANSPORT, useValue: wclTransport },
      { provide: WCL_INGEST_MODE, useValue: true },
      { provide: DATA_FILE_TRANSPORT, useValue: new FsDataFileTransport(dataDir) },
    ],
  });

  const env = TestBed.inject(EnvironmentInjector);
  booted = runInInjectionContext(env, () => ({
    wclApi: env.get(WclApi),
    dataFile: env.get(DataFileApi),
    transforms: {
      burst: env.get(Burst),
      rotation: env.get(Rotation),
      defensive: env.get(Defensive),
      gear: env.get(Gear),
      map: env.get(MapT),
    },
    clearWclCache: () => wclTransport.clearCache(),
    takeInaccessibleReportCodes: () => wclTransport.takeInaccessibleCodes(),
  }));
  return booted;
}
