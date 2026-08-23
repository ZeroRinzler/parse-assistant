import { inject, Injectable } from '@angular/core';
import { LoggerService } from '../observability/logger-service';

const NAV_COLLAPSED_KEY = 'wl.nav.collapsed';

// The mobile overlay's open state is deliberately not persisted, since a drawer sitting open over the content on load would be jarring.
@Injectable({ providedIn: 'root' })
export class NavStateStore {
  private readonly logger = inject(LoggerService);
  saveCollapsed(collapsed: boolean): void {
    try {
      localStorage.setItem(NAV_COLLAPSED_KEY, JSON.stringify(collapsed));
    } catch (err) {
      this.logger.logWarn('NavStateStore.saveCollapsed', err);
    }
  }

  loadCollapsed(): boolean {
    try {
      return localStorage.getItem(NAV_COLLAPSED_KEY) === 'true';
    } catch (err) {
      this.logger.logWarn('NavStateStore.loadCollapsed', err);
      return false;
    }
  }
}
