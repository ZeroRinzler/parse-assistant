import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { NgOptimizedImage } from '@angular/common';
import { MatTooltipModule } from '@angular/material/tooltip';
import { IconCacheService } from '../../../core/services/icon-cache';

export type GameIconKind = 'spell' | 'item';

/**
 * Renders a WoW spell or item as an icon + name that links to Wowhead.
 *
 * Spell icon art comes from the `IconCacheService` (seeded from a report's
 * `masterData.abilities`). Items are not in that cache, so callers pass the
 * icon filename and name explicitly (e.g. from WCL combatant-info gear). When
 * no icon is available the name still renders as a plain Wowhead link.
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
  private readonly iconCache = inject(IconCacheService);

  readonly id = input.required<number>();
  readonly kind = input<GameIconKind>('spell');
  /** Explicit display name; falls back to the icon cache, then a generic label. */
  readonly name = input<string>('');
  /** Explicit icon filename for items, which are not in the spell icon cache. */
  readonly icon = input<string>('');

  protected readonly iconUrl = computed(() => {
    const file = this.icon() || this.iconCache.get(this.id())?.icon || '';
    return file ? `https://wow.zamimg.com/images/wow/icons/small/${file}.jpg` : null;
  });

  protected readonly displayName = computed(() =>
    this.name() || this.iconCache.get(this.id())?.name || `${this.kind() === 'item' ? 'Item' : 'Spell'} ${this.id()}`);

  protected readonly wowheadUrl = computed(() => `https://www.wowhead.com/${this.kind()}=${this.id()}`);
}
