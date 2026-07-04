import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { FlyoverPanelComponent } from '../../../shared/components/flyover-panel/flyover-panel';
import { LiveCaptureFeatureService } from './live-capture.service';
import { ClipPlayerComponent } from './clip-player';

/**
 * Host for the recording flyover, composed from the shared `wl-flyover-panel` shell.
 * Mirrors `MapPanelComponent` - it injects exactly one service
 * (`LiveCaptureFeatureService`) and renders the video player when the panel is open. The
 * page renders this once and wires other cards' `openClip` outputs into `openClip`.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-clip-panel',
  imports: [FlyoverPanelComponent, ClipPlayerComponent],
  templateUrl: './clip-panel.html',
})
export class ClipPanelComponent {
  protected readonly clip = inject(LiveCaptureFeatureService);
}
