import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { NgOptimizedImage } from '@angular/common';

/** Unlike `wl-game-icon`, renders only a square image (no Wowhead link, no name); an empty `src` renders nothing. */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-art-icon',
  host: { class: 'inline-flex items-center shrink-0 align-middle' },
  imports: [NgOptimizedImage],
  templateUrl: './art-icon.html',
})
export class ArtIcon {
  /** Fully-resolved absolute image URL; '' renders nothing. */
  readonly src = input.required<string>();
  readonly alt = input.required<string>();
}
