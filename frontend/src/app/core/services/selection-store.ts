import { Injectable } from '@angular/core';
import { logWarn } from '../log';

/** Persisted player selection for the post-raid page. */
export interface PostRaidSelection {
  report: string | null;
  fight: number | null;
  player: number | null;
}

/** Persisted spec selection for the pre-fight page. */
export interface PreFightSelection {
  spec: string | null;
  encounter: number | null;
}

const POST_RAID_KEY = 'wl.sel.postRaid';
const PRE_FIGHT_KEY = 'wl.sel.preFight';

/**
 * Sticky selection persistence. URL query params always take priority; this store is
 * the fallback layer (URL param > localStorage > default). Every localStorage access is
 * wrapped so a disabled / full / unavailable storage never crashes the page - a failure
 * logs a warning and is treated as "no stored selection".
 */
@Injectable({ providedIn: 'root' })
export class SelectionStore {
  savePostRaid(value: PostRaidSelection): void {
    this._save(POST_RAID_KEY, value, 'SelectionStore.savePostRaid');
  }

  loadPostRaid(): PostRaidSelection | null {
    return this._load<PostRaidSelection>(POST_RAID_KEY, 'SelectionStore.loadPostRaid');
  }

  savePreFight(value: PreFightSelection): void {
    this._save(PRE_FIGHT_KEY, value, 'SelectionStore.savePreFight');
  }

  loadPreFight(): PreFightSelection | null {
    return this._load<PreFightSelection>(PRE_FIGHT_KEY, 'SelectionStore.loadPreFight');
  }

  private _save(key: string, value: unknown, context: string): void {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (err) {
      logWarn(context, err);
    }
  }

  private _load<TValue>(key: string, context: string): TValue | null {
    try {
      const stored = localStorage.getItem(key);
      if (!stored) return null;
      return JSON.parse(stored) as TValue;
    } catch (err) {
      logWarn(context, err);
      return null;
    }
  }
}
