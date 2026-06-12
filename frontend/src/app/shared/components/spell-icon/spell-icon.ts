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
      <a [href]="wowheadUrl()" target="_blank" rel="noopener" class="spell-icon-link">
        <img
          class="spell-icon"
          [class.size-small]="size() === 'small'"
          [class.size-medium]="size() === 'medium'"
          [ngSrc]="src"
          [width]="dim()"
          [height]="dim()"
          [alt]="iconName()"
          [matTooltip]="iconName()"
          (error)="onImgError($event)" />
      </a>
    }
  `,
  styleUrl: './spell-icon.scss',
})
export class SpellIconComponent {
  private readonly iconCache = inject(IconCacheService);

  readonly spellId = input.required<number>();
  readonly size = input<'small' | 'medium'>('small');
  readonly wowhead = input<boolean>(true);

  protected readonly iconUrl = computed(() => this.iconCache.iconUrl(this.spellId(), this.size()));
  protected readonly iconName = computed(() => this.iconCache.get(this.spellId())?.name || `Spell ${this.spellId()}`);
  protected readonly wowheadUrl = computed(() => `https://www.wowhead.com/spell=${this.spellId()}`);
  protected readonly dim = computed(() => (this.size() === 'medium' ? 36 : 18));

  protected onImgError(event: Event): void {
    (event.target as HTMLElement).style.display = 'none';
  }
}
