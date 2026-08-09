import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NavStateStore } from './nav-state-store';

// Mirrors NAV_COLLAPSED_KEY in the source; a stored preference outlives deploys, so changing the key orphans every visitor's saved choice.
const NAV_COLLAPSED_STORAGE_KEY = 'wl.nav.collapsed';

/** Stands in for a disabled, full, or otherwise unavailable localStorage. */
const STORAGE_FAILURE = 'localStorage unavailable';

/** Captures the store's logWarn output and keeps it out of the test log. */
function spyOnWarn() {
  return vi.spyOn(console, 'warn').mockImplementation(() => undefined);
}

describe('NavStateStore', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('persists the collapsed preference under its stable key and re-loads it', () => {
    new NavStateStore().saveCollapsed(true);

    expect(localStorage.getItem(NAV_COLLAPSED_STORAGE_KEY)).toBe(JSON.stringify(true));
    // A fresh instance proves the preference lives in localStorage, not on the object.
    expect(new NavStateStore().loadCollapsed()).toBe(true);
  });

  it('round-trips the expanded preference', () => {
    // Seed collapsed=true first so the expanded (false) save is distinguishable from the absent-key default.
    new NavStateStore().saveCollapsed(true);
    new NavStateStore().saveCollapsed(false);

    expect(localStorage.getItem(NAV_COLLAPSED_STORAGE_KEY)).toBe(JSON.stringify(false));
    expect(new NavStateStore().loadCollapsed()).toBe(false);
  });

  it('defaults to not collapsed when nothing has been stored yet', () => {
    expect(new NavStateStore().loadCollapsed()).toBe(false);
  });

  it('does not throw and logs a warning when the storage write fails', () => {
    const warn = spyOnWarn();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error(STORAGE_FAILURE);
    });

    expect(() => new NavStateStore().saveCollapsed(true)).not.toThrow();
    expect(warn).toHaveBeenCalled();
  });

  it('does not throw and defaults to not collapsed when the storage read fails', () => {
    const warn = spyOnWarn();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error(STORAGE_FAILURE);
    });
    const store = new NavStateStore();

    expect(() => store.loadCollapsed()).not.toThrow();
    expect(store.loadCollapsed()).toBe(false);
    expect(warn).toHaveBeenCalled();
  });
});
