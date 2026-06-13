import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { NgOptimizedImage } from '@angular/common';
import { MatTooltipModule } from '@angular/material/tooltip';
import { IconCacheService } from '../../../core/services/icon-cache';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-spell-icon',
  imports: [NgOptimizedImage, MatTooltipModule],
  template: `
    @if (iconUrl(); as src) {
      <a
        [href]="wowheadUrl()"
        target="_blank"
        rel="noopener"
        class="inline-flex items-center gap-1.5 no-underline hover:brightness-125">
        <img
          [ngSrc]="src"
          [width]="18"
          [height]="18" />
        <span>{{ iconName() }}</span>
      </a>
    }
  `,
})
export class SpellIconComponent {
  private readonly iconCache = inject(IconCacheService);

  readonly spellId = input.required<number>();

  protected readonly iconUrl = computed(() => this.iconCache.iconUrl(this.spellId()));
  protected readonly iconName = computed(() => this.iconCache.get(this.spellId())?.name || `Spell ${this.spellId()}`);
  protected readonly wowheadUrl = computed(() => `https://www.wowhead.com/spell=${this.spellId()}`);
}
