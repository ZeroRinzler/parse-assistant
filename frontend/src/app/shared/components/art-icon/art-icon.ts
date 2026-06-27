import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { NgOptimizedImage } from '@angular/common';

/**
 * Tiny presentational leaf for class / spec / boss artwork in dropdowns. Unlike
 * `wl-game-icon` (spells/items, which forces a Wowhead link and prints the name), this
 * renders only a square image with required alt text and never a link. Callers pass a
 * fully-resolved absolute URL; an empty `src` renders nothing (no broken image), which is
 * how an unknown spec degrades to name-only.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-art-icon',
  host: { class: 'inline-flex items-center shrink-0 align-middle' },
  imports: [NgOptimizedImage],
  templateUrl: './art-icon.html',
})
export class ArtIconComponent {
  /** Fully-resolved absolute image URL; '' renders nothing. */
  readonly src = input.required<string>();
  /** Required a11y text (class / spec / boss name). */
  readonly alt = input.required<string>();
  /** Square pixel size; the default suits a `mat-option` row. */
  readonly size = input<number>(20);
}
