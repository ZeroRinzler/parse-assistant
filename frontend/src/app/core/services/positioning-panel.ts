import { Injectable, signal } from '@angular/core';
import { EncounterPositions, ReferenceSelector } from '../models/positioning.models';
import { LiveOverlay } from '../../shared/components/positioning-map/positioning-map';

/**
 * Shared state for the positioning map panel. A page sets the context (ingested
 * top-parse positions + optional live overlay) once per analysis; feature cards
 * (burst windows, suggestions, defensive windows) call `openAt` to pop the map
 * at a given moment and reference. The panel host renders from these signals.
 */
@Injectable({ providedIn: 'root' })
export class PositioningPanelService {
  readonly open = signal(false);
  readonly positions = signal<EncounterPositions | null>(null);
  readonly live = signal<LiveOverlay | null>(null);
  readonly anchorTime = signal(0);
  readonly reference = signal<ReferenceSelector>({ kind: 'boss' });
  readonly contextLabel = signal('');

  /** Called by a page after analysis. `live` is null on pages with no pull (e.g. /pre). */
  setContext(positions: EncounterPositions | null, live: LiveOverlay | null): void {
    this.positions.set(positions);
    this.live.set(live);
  }

  openAt(anchorTime: number, reference: ReferenceSelector, contextLabel = ''): void {
    this.anchorTime.set(anchorTime);
    this.reference.set(reference);
    this.contextLabel.set(contextLabel);
    this.open.set(true);
  }

  close(): void { this.open.set(false); }

  clear(): void {
    this.open.set(false);
    this.positions.set(null);
    this.live.set(null);
  }
}
