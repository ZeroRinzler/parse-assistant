import { Injectable } from '@angular/core';
import { logWarn } from '../log';

// Only the player NAME is kept: WCL actor ids are per-report (not stable across pulls or logs).
export interface PostRaidSelection {
  playerName: string | null;
}

export interface PreFightSelection {
  spec: string | null;
}

// Stored as the set of cooldown spell ids the user has DESELECTED, so a cooldown that first appears for a new spec/encounter defaults to checked.
export interface NorthernSkyExportSelection {
  excludedSpellIds: number[];
}

const POST_RAID_KEY = 'wl.sel.postRaid';
const PRE_FIGHT_KEY = 'wl.sel.preFight';
const NORTHERN_SKY_KEY = 'wl.sel.northernSky';

// There are no URL query params by design, so sticky state lives only in localStorage.
@Injectable({ providedIn: 'root' })
export class SelectionStore {
  savePostRaid(value: PostRaidSelection): void {
    this._save(POST_RAID_KEY, value, 'SelectionStore.savePostRaid');
  }

  loadPostRaid(): PostRaidSelection | null {
    return this._load(POST_RAID_KEY, 'SelectionStore.loadPostRaid') as PostRaidSelection | null;
  }

  savePreFight(value: PreFightSelection): void {
    this._save(PRE_FIGHT_KEY, value, 'SelectionStore.savePreFight');
  }

  loadPreFight(): PreFightSelection | null {
    return this._load(PRE_FIGHT_KEY, 'SelectionStore.loadPreFight') as PreFightSelection | null;
  }

  saveNorthernSky(value: NorthernSkyExportSelection): void {
    this._save(NORTHERN_SKY_KEY, value, 'SelectionStore.saveNorthernSky');
  }

  loadNorthernSky(): NorthernSkyExportSelection | null {
    return this._load(NORTHERN_SKY_KEY, 'SelectionStore.loadNorthernSky') as NorthernSkyExportSelection | null;
  }

  private _save(key: string, value: unknown, context: string): void {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (err) {
      logWarn(context, err);
    }
  }

  private _load(key: string, context: string): unknown {
    try {
      const stored = localStorage.getItem(key);
      if (!stored) return null;
      return JSON.parse(stored) as unknown;
    } catch (err) {
      logWarn(context, err);
      return null;
    }
  }
}
