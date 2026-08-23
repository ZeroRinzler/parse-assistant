import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { LoadError } from '../../../core/http/result';

/** The hard-error kinds this panel renders; a null error is the waiting (not-yet-ingested) state. */
export type RenderableLoadError = Extract<LoadError, { kind: 'transient' | 'permanent' }>;

/** Card-shaped stand-in for a bench-driven card with no data: shows the load error, or a waiting state for an un-ingested tier. */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-load-state',
  imports: [MatIconModule],
  host: { class: 'block' },
  templateUrl: './load-state.html',
})
export class LoadState {
  readonly heading = input<string>('');
  readonly subtitle = input<string>('');
  readonly caption = input<string>('Built from the top-parse bench.');
  readonly error = input<RenderableLoadError | null>(null);
}
