import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';
import { logWarn } from './app/core/log';

bootstrapApplication(App, appConfig)
  .catch((err) => logWarn('bootstrapApplication', err));
