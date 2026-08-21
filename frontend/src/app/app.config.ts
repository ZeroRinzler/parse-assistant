import {
  ApplicationConfig,
  provideBrowserGlobalErrorListeners,
  provideEnvironmentInitializer,
  inject,
} from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { MatIconRegistry } from '@angular/material/icon';
import { routes } from './app.routes';
import { WCL_TRANSPORT } from './core/services/wcl-transport';
import { HttpWclTransport } from './core/transport/http-wcl-transport';
import { provideWclCaching } from './core/services/wcl-caching';
import { DATA_FILE_TRANSPORT } from './core/services/data-file-transport';
import { HttpDataFileTransport } from './core/transport/http-data-file-transport';
import { provideAppHttp } from './core/transport/http.providers';
import { environmentProviders } from '../environments/environment';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes, withComponentInputBinding()),
    provideAppHttp(),
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
