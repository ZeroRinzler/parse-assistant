import { afterNextRender, ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { NgOptimizedImage } from '@angular/common';
import { WowheadTooltipsService } from '../../../core/services/wowhead-tooltips';

export type GameIconKind = 'spell' | 'item';

/** Renders a WoW spell or item as an icon + name linking to Wowhead; an empty icon or a failed image load falls back to name-only. */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-game-icon',
  host: { class: 'inline-flex items-center' },
  imports: [NgOptimizedImage],
  templateUrl: './game-icon.html',
})
export class GameIconComponent {
  constructor() {
    // Load the tooltip enhancer on first render; afterNextRender is browser-only, so prerender skips it.
    const tooltips = inject(WowheadTooltipsService);
    afterNextRender(() => {
      tooltips.ensureLoaded();
      // Re-scan so an icon rendered after the load-time scan still gets a tooltip.
      tooltips.refreshLinks();
    });
  }

  readonly id = input.required<number>();
  readonly kind = input<GameIconKind>('spell');
  readonly name = input.required<string>();
  /** Explicit icon filename; an empty string renders name-only (no art). */
  readonly icon = input.required<string>();

  // Tracks the URL that last failed to load so the template hides it and degrades to name-only; a changed `icon` retries.
  protected readonly failedSrc = signal<string | null>(null);

  // WCL's master-data icons may already carry a `.jpg` extension; strip it first so the zamimg URL never doubles up.
  protected readonly iconUrl = computed(() => {
    const file = this.icon().replace(/\.(jpg|jpeg|png|gif|webp)$/i, '');
    return file ? `https://wow.zamimg.com/images/wow/icons/small/${file}.jpg` : null;
  });

  protected readonly wowheadUrl = computed(() => `https://www.wowhead.com/${this.kind()}=${this.id()}`);
}
