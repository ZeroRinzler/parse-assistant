import {
  afterNextRender, ChangeDetectionStrategy, Component, DestroyRef, ElementRef, inject, signal, viewChild,
} from '@angular/core';
import { MatIconModule } from '@angular/material/icon';

/** On mobile, clamps projected content to two lines behind a "Show more / Show less" toggle; unclamped at >=md. */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-collapsible-text',
  // Angular custom elements default to display:inline; block keeps the clamp + toggle stacked.
  host: { class: 'block' },
  imports: [MatIconModule],
  templateUrl: './collapsible-text.html',
})
export class CollapsibleText {
  private readonly destroyRef = inject(DestroyRef);
  private readonly content = viewChild.required<ElementRef<HTMLElement>>('content');

  protected readonly expanded = signal(false);
  protected readonly overflowing = signal(false);

  constructor() {
    afterNextRender(() => {
      const el = this.content().nativeElement;
      const measure = (): void => {
        // Once expanded the clamp is off and scrollHeight === clientHeight, so keep the last collapsed reading.
        if (this.expanded()) return;
        this.overflowing.set(el.scrollHeight - el.clientHeight > 1);
      };
      measure();
      if (typeof ResizeObserver !== 'undefined') {
        const observer = new ResizeObserver(measure);
        observer.observe(el);
        this.destroyRef.onDestroy(() => { observer.disconnect(); });
      }
    });
  }

  protected toggle(): void {
    this.expanded.update(open => !open);
  }
}
