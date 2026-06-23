import { Injectable, signal } from '@angular/core';
import { WclAbility } from '../models/wcl.models';

export interface IconInfo {
  icon: string;
  name: string;
}

@Injectable({ providedIn: 'root' })
export class IconCacheService {
  private readonly _cache = signal<Record<string, IconInfo>>({});

  seed(abilities: WclAbility[]): void {
    const updated = { ...this._cache() };
    for (const a of abilities) {
      if (a.gameID && a.icon) {
        updated[String(a.gameID)] = { icon: a.icon.replace(/\.jpg$/i, ''), name: a.name };
      }
    }
    this._cache.set(updated);
  }

  seedFromMap(map: Record<string, { icon: string; name: string }>): void {
    const updated = { ...this._cache() };
    Object.assign(updated, map);
    this._cache.set(updated);
  }

  get(spellId: number | string): IconInfo | null {
    return this._cache()[String(spellId)] ?? null;
  }

  iconUrl(spellId: number | string): string | null {
    const info = this.get(spellId);
    if (!info?.icon) return null;
    return `https://wow.zamimg.com/images/wow/icons/small/${info.icon}.jpg`;
  }
}
