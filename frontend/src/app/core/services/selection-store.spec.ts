import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PostRaidSelection, PreFightSelection, SelectionStore } from './selection-store';

// Mirror POST_RAID_KEY / PRE_FIGHT_KEY in the source; stored selections outlive deploys, so changing a key orphans every visitor's saved state.
const POST_RAID_STORAGE_KEY = 'wl.sel.postRaid';
const PRE_FIGHT_STORAGE_KEY = 'wl.sel.preFight';

const POST_RAID_SELECTION: PostRaidSelection = { playerName: 'Shadowmaster' };
const PRE_FIGHT_SELECTION: PreFightSelection = { spec: 'SubtletyRogue' };

/** A torn or truncated write leaves a stored value JSON.parse rejects. */
const CORRUPTED_STORED_VALUE = '{"playerName":';

/** Stands in for a disabled, full, or otherwise unavailable localStorage. */
const STORAGE_FAILURE = 'localStorage unavailable';

/** Captures the store's logWarn output and keeps it out of the test log. */
function spyOnWarn() {
  return vi.spyOn(console, 'warn').mockImplementation(() => undefined);
}

describe('SelectionStore', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('persists the post-raid selection under its stable key and re-loads it', () => {
    new SelectionStore().savePostRaid(POST_RAID_SELECTION);

    expect(localStorage.getItem(POST_RAID_STORAGE_KEY)).toBe(JSON.stringify(POST_RAID_SELECTION));
    // A fresh instance proves the selection lives in localStorage, not on the object.
    expect(new SelectionStore().loadPostRaid()).toEqual(POST_RAID_SELECTION);
  });

  it('persists the pre-fight selection under its stable key and re-loads it', () => {
    new SelectionStore().savePreFight(PRE_FIGHT_SELECTION);

    expect(localStorage.getItem(PRE_FIGHT_STORAGE_KEY)).toBe(JSON.stringify(PRE_FIGHT_SELECTION));
    expect(new SelectionStore().loadPreFight()).toEqual(PRE_FIGHT_SELECTION);
  });

  it('returns null when nothing has been stored yet', () => {
    const store = new SelectionStore();

    expect(store.loadPostRaid()).toBeNull();
    expect(store.loadPreFight()).toBeNull();
  });

  it('returns null and logs a warning when the stored JSON is corrupted', () => {
    const warn = spyOnWarn();
    localStorage.setItem(POST_RAID_STORAGE_KEY, CORRUPTED_STORED_VALUE);

    expect(new SelectionStore().loadPostRaid()).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it('does not throw and logs a warning when the storage write fails', () => {
    const warn = spyOnWarn();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error(STORAGE_FAILURE);
    });

    expect(() => { new SelectionStore().savePostRaid(POST_RAID_SELECTION); }).not.toThrow();
    expect(warn).toHaveBeenCalled();
  });

  it('does not throw and returns null when the storage read fails', () => {
    const warn = spyOnWarn();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error(STORAGE_FAILURE);
    });
    const store = new SelectionStore();

    expect(() => store.loadPostRaid()).not.toThrow();
    expect(store.loadPostRaid()).toBeNull();
    expect(warn).toHaveBeenCalled();
  });
});
