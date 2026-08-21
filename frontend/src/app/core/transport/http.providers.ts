import { EnvironmentProviders } from '@angular/core';
import { provideHttpClient, withInterceptors, withInterceptorsFromDi } from '@angular/common/http';
import { retryTransientInterceptor } from './retry-transient.interceptor';

// withInterceptorsFromDi() admits the DI-registered ng-http-caching interceptor into the same chain.
export function provideAppHttp(): EnvironmentProviders {
  return provideHttpClient(withInterceptors([retryTransientInterceptor]), withInterceptorsFromDi());
}
