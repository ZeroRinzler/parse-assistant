import { ChangeDetectionStrategy, Component } from '@angular/core';

/**
 * Small info callout - accent left border on a tinted surface. Used for coaching
 * remedies ("Consider holding ...") and other inline notes so they read the same
 * everywhere. Spacing (margins) is left to the caller via class bindings.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-callout',
  host: {
    class:
      'block rounded-r border-l-2 border-[var(--accent)] bg-[var(--accent)]/[0.07] px-2.5 py-1.5 text-[11px] leading-relaxed text-[var(--muted)]',
  },
  template: `<ng-content />`,
})
export class CalloutComponent {}
