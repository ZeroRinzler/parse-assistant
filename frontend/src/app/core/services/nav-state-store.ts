import { Injectable } from '@angular/core';
import { logWarn } from '../log';

const NAV_COLLAPSED_KEY = 'wl.nav.collapsed';

/**
 * Persists whether the desktop navigation drawer is collapsed to its icons-only rail,
 * so the choice survives across sessions. Mirrors SelectionStore's wrapped-localStorage
 * approach: a disabled / full / unavailable storage never crashes the page - a failure
 * logs a warning and reads back as "not collapsed". The mobile overlay's open state is
 * deliberately not persisted, since a drawer sitting open over the content on load would
 * be jarring.
 */
@Injectable({ providedIn: 'root' })
export class NavStateStore {
  saveCollapsed(collapsed: boolean): void {
    try {
      localStorage.setItem(NAV_COLLAPSED_KEY, JSON.stringify(collapsed));
    } catch (err) {
      logWarn('NavStateStore.saveCollapsed', err);
    }
  }

  loadCollapsed(): boolean {
    try {
      return localStorage.getItem(NAV_COLLAPSED_KEY) === 'true';
    } catch (err) {
      logWarn('NavStateStore.loadCollapsed', err);
      return false;
    }
  }
}
