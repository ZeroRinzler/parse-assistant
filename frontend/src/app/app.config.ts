import {
  ApplicationConfig,
  provideBrowserGlobalErrorListeners,
  provideEnvironmentInitializer,
  provideAppInitializer,
  inject,
} from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { provideHttpClient, withFetch } from '@angular/common/http';
import { MatIconRegistry } from '@angular/material/icon';
import { DomSanitizer } from '@angular/platform-browser';
import { provideApollo } from 'apollo-angular';
import { HttpLink } from 'apollo-angular/http';
import { InMemoryCache } from '@apollo/client';
import { routes } from './app.routes';
import { WCL_TRANSPORT, WCL_API_URL } from './core/services/wcl-transport';
import { ApolloWclTransport } from './core/services/apollo-wcl-transport';
import { DATA_FILE_TRANSPORT, HttpDataFileTransport } from './core/services/data-file-transport';
import { DataFileApiService } from './core/services/data-file-api';
import { hydrateSpecMeta } from './core/spec-meta';
import { dataSourceProviders } from '../environments/environment';

const GITHUB_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
  <path d="M12 0C5.37 0 0 5.373 0 12c0 5.303 3.438 9.8 8.205 11.387.6.113.82-.258.82-.577
    0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61-.546-1.387-1.333-1.756-1.333-1.756
    -1.089-.745.083-.73.083-.73 1.205.084 1.84 1.237 1.84 1.237 1.07 1.834 2.807 1.304 3.492.997
    .107-.775.418-1.305.762-1.605-2.665-.305-5.467-1.334-5.467-5.931 0-1.31.465-2.381 1.235-3.221
    -.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138
    3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.911 1.23 3.221
    0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222 0 1.606-.015 2.896-.015 3.286
    0 .315.21.69.825.57C20.565 21.796 24 17.3 24 12c0-6.627-5.373-12-12-12z"/>
</svg>`;

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes, withComponentInputBinding()),
    provideAnimationsAsync(),
    provideHttpClient(withFetch()),
    provideAppInitializer(async () => {
      // Hydrate the spec-meta cache (folder -> class/spec names + icons) from the baked
      // spec-meta.json before anything renders, so the class/spec dropdowns, the icon pipes,
      // and getRankings resolve. One tiny (~40-entry) file fetch, blocking bootstrap.
      const dataFile = inject(DataFileApiService);
      hydrateSpecMeta(await dataFile.getSpecMeta());
    }),
    provideApollo(() => {
      // HttpLink rides on Angular's HttpClient; the per-request bearer token is supplied
      // via operation context in WclApiService, so no auth link is configured here.
      const httpLink = inject(HttpLink);
      return { cache: new InMemoryCache(), link: httpLink.create({ uri: WCL_API_URL }) };
    }),
    provideEnvironmentInitializer(() => {
      const iconRegistry = inject(MatIconRegistry);
      const sanitizer = inject(DomSanitizer);
      iconRegistry.setDefaultFontSetClass('material-symbols-outlined');
      iconRegistry.addSvgIconLiteral('github', sanitizer.bypassSecurityTrustHtml(GITHUB_SVG));
    }),
    // WCL GraphQL transport: apollo-angular in the browser (its InMemoryCache dedupes and
    // memoises the cache-first reads, so the five feature cards share one report/event fetch).
    // The Node ingestion binds a plain-fetch transport instead, since apollo-angular does not
    // run headless.
    { provide: WCL_TRANSPORT, useExisting: ApolloWclTransport },
    // Data-file transport: HTTP read-only in the browser (Node ingestion binds a fs read+write one).
    { provide: DATA_FILE_TRANSPORT, useExisting: HttpDataFileTransport },
    // Vertical-slice data sources: file-backed in production, live transforms under the dev
    // flag. The list is defined per-environment so a production build never imports (and thus
    // tree-shakes out) the five `*TransformService`s.
    ...dataSourceProviders,
  ],
};
