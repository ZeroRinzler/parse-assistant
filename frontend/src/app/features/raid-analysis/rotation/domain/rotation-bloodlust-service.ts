import { inject, Injectable } from '@angular/core';
import { TimedEvent } from '../../../../domain/analysis/wcl-projections-service';
import { AuraWindowsService } from '../../../../domain/analysis/aura-windows-service';

@Injectable({ providedIn: 'root' })
export class RotationBloodlustService {
  private readonly auraWindows = inject(AuraWindowsService);

  // Returns whatever start buildAuraWindows finds, negative included: a Lust cast before the pull still covers the opener.
  detectBloodlust(buffEvents: TimedEvent[]): number | null {
    const windows = this.auraWindows.buildAuraWindows(buffEvents);
    const starts = [...BLOODLUST_IDS]
      .map(id => windows.get(id)?.[0]?.[0])
      .filter((start): start is number => start != null);
    return starts.length ? Math.min(...starts) : null;
  }
}

/** Bloodlust / Heroism / Time Warp and equivalents. */
const BLOODLUST_IDS = new Set([2825, 32182, 80353, 90355, 264667, 390386]);
