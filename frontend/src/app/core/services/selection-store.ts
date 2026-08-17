import { Injectable } from '@angular/core';
import * as z from '../zod-mini';
import { logWarn } from '../log';
import { parseJson } from '../json';

// Only the player NAME is kept: WCL actor ids are per-report (not stable across pulls or logs).
const POST_RAID_SCHEMA = z.object({ playerName: z.nullable(z.string()) });
export type PostRaidSelection = z.infer<typeof POST_RAID_SCHEMA>;

const PRE_FIGHT_SCHEMA = z.object({ spec: z.nullable(z.string()) });
export type PreFightSelection = z.infer<typeof PRE_FIGHT_SCHEMA>;

// Stored as the set of cooldown spell ids the user has DESELECTED, so a cooldown that first appears for a new spec/encounter defaults to checked.
const NORTHERN_SKY_SCHEMA = z.object({ excludedSpellIds: z.array(z.number()) });
export type NorthernSkyExportSelection = z.infer<typeof NORTHERN_SKY_SCHEMA>;

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
    return this._load(POST_RAID_KEY, POST_RAID_SCHEMA, 'SelectionStore.loadPostRaid');
  }

  savePreFight(value: PreFightSelection): void {
    this._save(PRE_FIGHT_KEY, value, 'SelectionStore.savePreFight');
  }

  loadPreFight(): PreFightSelection | null {
    return this._load(PRE_FIGHT_KEY, PRE_FIGHT_SCHEMA, 'SelectionStore.loadPreFight');
  }

  saveNorthernSky(value: NorthernSkyExportSelection): void {
    this._save(NORTHERN_SKY_KEY, value, 'SelectionStore.saveNorthernSky');
  }

  loadNorthernSky(): NorthernSkyExportSelection | null {
    return this._load(NORTHERN_SKY_KEY, NORTHERN_SKY_SCHEMA, 'SelectionStore.loadNorthernSky');
  }

  private _save(key: string, value: unknown, context: string): void {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (err) {
      logWarn(context, err);
    }
  }

  private _load<S extends z.ZodMiniType>(key: string, schema: S, context: string): z.infer<S> | null {
    try {
      const stored = localStorage.getItem(key);
      if (!stored) return null;
      return parseJson(schema, stored, context);
    } catch (err) {
      logWarn(context, err);
      return null;
    }
  }
}
