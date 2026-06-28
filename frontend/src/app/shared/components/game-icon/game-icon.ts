import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { NgOptimizedImage } from '@angular/common';
import { MatTooltipModule } from '@angular/material/tooltip';

export type GameIconKind = 'spell' | 'item';

/**
 * Renders a WoW spell or item as an icon + name that links to Wowhead.
 *
 * Inputs-only leaf with three required inputs: callers pass `id`, `icon`, and
 * `name` explicitly on every use - feature services resolve icon + name from the
 * ingest-baked `ability_icons` map (or the report's `masterData.abilities`). There
 * is no fallback here: an empty `icon` legitimately renders name-only (no art),
 * and `name` is always supplied by the caller.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-game-icon',
  host: { class: 'inline-flex items-center' },
  imports: [NgOptimizedImage, MatTooltipModule],
  template: `
    <a
      [href]="wowheadUrl()"
      target="_blank"
      rel="noopener"
      class="inline-flex items-center gap-1.5 no-underline hover:brightness-125">
      @if (iconUrl(); as src) {
        <img [ngSrc]="src" [width]="18" [height]="18" alt="" class="rounded-sm" />
      }
      <span>{{ name() }}</span>
    </a>
  `,
})
export class GameIconComponent {
  readonly id = input.required<number>();
  readonly kind = input<GameIconKind>('spell');
  /** Explicit display name (always provided by the caller). */
  readonly name = input.required<string>();
  /** Explicit icon filename; an empty string renders name-only (no art). */
  readonly icon = input.required<string>();

  // The icon may arrive with or without a trailing image extension (WCL's
  // master-data icons carry `.jpg`); normalize before appending the zamimg suffix
  // so the URL never doubles up (`foo.jpg.jpg`).
  protected readonly iconUrl = computed(() => {
    const file = this.icon().replace(/\.(jpg|jpeg|png|gif|webp)$/i, '');
    return file ? `https://wow.zamimg.com/images/wow/icons/small/${file}.jpg` : null;
  });

  protected readonly wowheadUrl = computed(() => `https://www.wowhead.com/${this.kind()}=${this.id()}`);
}
