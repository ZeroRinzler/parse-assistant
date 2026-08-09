import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { LiveCaptureFeatureService } from './live-capture.service';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-live-controls',
  imports: [MatSlideToggleModule, MatProgressSpinnerModule],
  templateUrl: './live-controls.html',
})
export class LiveControlsComponent {
  protected readonly capture = inject(LiveCaptureFeatureService);

  protected onLiveToggle(checked: boolean): void {
    this.capture.setLive(checked);
  }

  protected onRecordToggle(checked: boolean): void {
    if (checked) void this.capture.startRecording();
    else this.capture.stopRecording();
  }
}
