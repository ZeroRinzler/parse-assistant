import {
  ApplicationConfig,
  provideBrowserGlobalErrorListeners,
  provideEnvironmentInitializer,
  inject,
} from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { provideHttpClient, withFetch, withInterceptors, withInterceptorsFromDi } from '@angular/common/http';
import { MatIconRegistry } from '@angular/material/icon';
import { routes } from './app.routes';
import { WCL_TRANSPORT } from './core/services/wcl-transport';
import { HttpWclTransport } from './core/services/http-wcl-transport';
import { provideWclCaching } from './core/services/wcl-caching';
import { DATA_FILE_TRANSPORT } from './core/services/data-file-transport';
import { HttpDataFileTransport } from './core/services/http-data-file-transport';
import { retryTransientInterceptor } from './core/interceptors/retry-transient.interceptor';
import { environmentProviders } from '../environments/environment';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes, withComponentInputBinding()),
    provideAnimationsAsync(),
    // withInterceptorsFromDi() admits the DI-registered ng-http-caching interceptor into the same chain.
    provideHttpClient(withFetch(), withInterceptors([retryTransientInterceptor]), withInterceptorsFromDi()),
    provideWclCaching(),
    provideEnvironmentInitializer(() => {
      inject(MatIconRegistry).setDefaultFontSetClass('material-symbols-outlined');
    }),
    { provide: WCL_TRANSPORT, useExisting: HttpWclTransport },
    { provide: DATA_FILE_TRANSPORT, useExisting: HttpDataFileTransport },
    // Last so an environment can override the bindings above (the ingest one swaps the data-file transport).
    ...environmentProviders,
  ],
};
