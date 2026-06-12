import { Component, computed, inject, input } from '@angular/core';
import { MatTooltipModule } from '@angular/material/tooltip';
import { IconCacheService } from '../../../core/services/icon-cache';

@Component({
  selector: 'wl-spell-icon',
  imports: [MatTooltipModule],
  template: `
    @if (iconUrl()) {
      <a [href]="wowheadUrl()" target="_blank" rel="noopener" class="spell-icon-link">
        <img
          class="spell-icon"
          [class.size-small]="size() === 'small'"
          [class.size-medium]="size() === 'medium'"
          [src]="iconUrl()!"
          [alt]="iconName()"
          [matTooltip]="iconName()"
          loading="lazy"
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

  protected onImgError(event: Event): void {
    (event.target as HTMLElement).style.display = 'none';
  }
}
