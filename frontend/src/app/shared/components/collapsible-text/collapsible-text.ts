import {
  afterNextRender, ChangeDetectionStrategy, Component, DestroyRef, ElementRef, inject, signal, viewChild,
} from '@angular/core';
import { MatIconModule } from '@angular/material/icon';

/**
 * Collapsible text disclosure. Projects its content and, on mobile, clamps it to
 * two lines behind a "Show more / Show less" toggle. At >=md the content is never
 * clamped and the toggle is hidden, so desktop always shows the full text (the
 * frozen desktop layout). The toggle is also hidden when the content already fits
 * in two lines (nothing to expand). Presentational leaf: owns only its own state -
 * no inputs, no services.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-collapsible-text',
  // Angular custom elements default to display:inline; block keeps the clamp + toggle stacked.
  host: { class: 'block' },
  imports: [MatIconModule],
  templateUrl: './collapsible-text.html',
})
export class CollapsibleTextComponent {
  private readonly destroyRef = inject(DestroyRef);
  private readonly content = viewChild.required<ElementRef<HTMLElement>>('content');

  protected readonly expanded = signal(false);
  /** True only when the clamped content actually overflows two lines. */
  protected readonly overflowing = signal(false);

  constructor() {
    afterNextRender(() => {
      const el = this.content().nativeElement;
      const measure = (): void => {
        // Only meaningful while clamped: once expanded the clamp is off and
        // scrollHeight === clientHeight, so keep the last collapsed reading.
        if (this.expanded()) return;
        this.overflowing.set(el.scrollHeight - el.clientHeight > 1);
      };
      measure();
      if (typeof ResizeObserver !== 'undefined') {
        const observer = new ResizeObserver(measure);
        observer.observe(el);
        this.destroyRef.onDestroy(() => observer.disconnect());
      }
    });
  }

  protected toggle(): void {
    this.expanded.update(open => !open);
  }
}
