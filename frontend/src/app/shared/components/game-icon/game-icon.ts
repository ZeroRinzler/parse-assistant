import { afterNextRender, ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { NgOptimizedImage } from '@angular/common';
import { WowheadTooltipsService } from '../../../core/services/wowhead-tooltips';

export type GameIconKind = 'spell' | 'item';

/**
 * Renders a WoW spell or item as an icon + name that links to Wowhead.
 *
 * Inputs-only leaf with three required inputs: callers pass `id`, `icon`, and
 * `name` explicitly on every use - feature services resolve icon + name from the
 * ingest-baked `ability_icons` map (or the report's `masterData.abilities`). An
 * empty `icon` legitimately renders name-only (no art), and a resolved icon whose
 * image fails to load falls back to the same name-only rendering (no broken-image
 * glyph); `name` is always supplied by the caller.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-game-icon',
  host: { class: 'inline-flex items-center' },
  imports: [NgOptimizedImage],
  template: `
    <a
      [href]="wowheadUrl()"
      target="_blank"
      rel="noopener"
      class="inline-flex items-center gap-1.5 no-underline hover:brightness-125">
      @if (iconUrl(); as src) {
        @if (failedSrc() !== src) {
          <img [ngSrc]="src" [width]="18" [height]="18" alt="" class="rounded-sm" (error)="failedSrc.set(src)" />
        }
      }
      <!-- text-sm keeps names the same size as the no-icon fallback names next to
           this component (finding-table, compact-ability-row, the plan cards). -->
      <span class="text-sm">{{ name() }}</span>
    </a>
  `,
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
  /** Explicit display name (always provided by the caller). */
  readonly name = input.required<string>();
  /** Explicit icon filename; an empty string renders name-only (no art). */
  readonly icon = input.required<string>();

  // The URL whose image last failed to load; the template hides that img so a
  // broken art request degrades to name-only. A changed `icon` yields a new URL
  // that no longer matches, so the image is retried.
  protected readonly failedSrc = signal<string | null>(null);

  // The icon may arrive with or without a trailing image extension (WCL's
  // master-data icons carry `.jpg`); normalize before appending the zamimg suffix
  // so the URL never doubles up (`foo.jpg.jpg`).
  protected readonly iconUrl = computed(() => {
    const file = this.icon().replace(/\.(jpg|jpeg|png|gif|webp)$/i, '');
    return file ? `https://wow.zamimg.com/images/wow/icons/small/${file}.jpg` : null;
  });

  protected readonly wowheadUrl = computed(() => `https://www.wowhead.com/${this.kind()}=${this.id()}`);
}
