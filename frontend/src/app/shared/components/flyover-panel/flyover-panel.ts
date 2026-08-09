import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';

/** Responsive flyover shell shared by the positioning map and the clip replay. */
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
  readonly closeLabel = input.required<string>();
  readonly closed = output<void>();
}
