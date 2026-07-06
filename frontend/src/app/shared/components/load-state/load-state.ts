import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { LoadError } from '../../../core/result';

/** The hard-error kinds this panel renders; a null error is the waiting (not-yet-ingested) state. */
export type RenderableLoadError = Extract<LoadError, { kind: 'transient' | 'permanent' }>;

/**
 * Card-shaped stand-in shown in place of a bench-driven card that has no data to render:
 * an `error` shows the transient/permanent failure, otherwise the waiting state for a fresh,
 * un-ingested tier. `heading`/`subtitle` mirror the card it replaces (omit them for a
 * standalone error with no card header).
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-load-state',
  imports: [MatIconModule],
  host: { class: 'block' },
  templateUrl: './load-state.html',
})
export class LoadStateComponent {
  readonly heading = input<string>('');
  readonly subtitle = input<string>('');
  readonly caption = input<string>('Built from the top-parse bench.');
  readonly error = input<RenderableLoadError | null>(null);
}
