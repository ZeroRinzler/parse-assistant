import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';

/**
 * Card-shaped "Waiting for top parses" placeholder shown in place of a bench-driven card
 * on a fresh, un-ingested tier. Inputs-only leaf; `heading`/`subtitle` mirror the card it
 * replaces.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-waiting-placeholder',
  imports: [MatIconModule],
  host: { class: 'block' },
  templateUrl: './waiting-placeholder.html',
})
export class WaitingPlaceholderComponent {
  readonly heading = input<string>('');
  readonly subtitle = input<string>('');
  readonly caption = input<string>('Built from the top-parse bench.');
}
