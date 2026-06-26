import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { NgOptimizedImage } from '@angular/common';
import { MatTooltipModule } from '@angular/material/tooltip';

export type GameIconKind = 'spell' | 'item';

/**
 * Renders a WoW spell or item as an icon + name that links to Wowhead.
 *
 * Inputs-only leaf: callers pass the icon filename and display name explicitly
 * (feature services resolve them from the report's `masterData.abilities` or the
 * ingest-baked slice data). When no icon is supplied the name still renders as a
 * plain Wowhead link.
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
        <img [ngSrc]="src" [width]="18" [height]="18" alt="" />
      }
      <span>{{ displayName() }}</span>
    </a>
  `,
})
export class GameIconComponent {
  readonly id = input.required<number>();
  readonly kind = input<GameIconKind>('spell');
  /** Explicit display name; falls back to a generic label when empty. */
  readonly name = input<string>('');
  /** Explicit icon filename (without extension); no art renders when empty. */
  readonly icon = input<string>('');

  protected readonly iconUrl = computed(() => {
    const file = this.icon();
    return file ? `https://wow.zamimg.com/images/wow/icons/small/${file}.jpg` : null;
  });

  protected readonly displayName = computed(() =>
    this.name() || `${this.kind() === 'item' ? 'Item' : 'Spell'} ${this.id()}`);

  protected readonly wowheadUrl = computed(() => `https://www.wowhead.com/${this.kind()}=${this.id()}`);
}
