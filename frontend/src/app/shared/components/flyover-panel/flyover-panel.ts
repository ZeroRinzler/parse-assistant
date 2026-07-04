import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';

/**
 * Responsive flyover shell shared by the positioning map and the clip replay: a
 * full-screen sheet on mobile, a right-side 460px drawer on desktop (the switch is pure
 * Tailwind `md:` utilities in the template). A presentational leaf - inputs/outputs
 * only; the host decides when it renders and projects the body content.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-flyover-panel',
  imports: [MatButtonModule, MatIconModule],
  templateUrl: './flyover-panel.html',
})
export class FlyoverPanelComponent {
  readonly heading = input.required<string>();
  /** Muted status text beside the heading; empty renders nothing. */
  readonly loadingText = input<string>('');
  /** Accessible label for the close button. */
  readonly closeLabel = input.required<string>();
  readonly closed = output<void>();
}
