import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, effect, inject, viewChild } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { LoadingSpinner } from '../../../../shared/components/loading-spinner/loading-spinner';
import { LiveCaptureFeatureService } from '../facade/live-capture-feature-service';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-clip-player',
  imports: [MatButtonModule, MatIconModule, LoadingSpinner],
  templateUrl: './clip-player.html',
})
export class ClipPlayer {
  protected readonly clip = inject(LiveCaptureFeatureService);
  private readonly player = viewChild<ElementRef<HTMLVideoElement>>('player');

  private srcUrl = '';

  constructor() {
    effect(() => {
      const blob = this.clip.handle()?.blob;
      const video = this.player()?.nativeElement;
      if (!video) return;
      this.releaseSrc();
      if (!blob) return;
      this.srcUrl = URL.createObjectURL(blob);
      video.src = this.srcUrl;
    });
    inject(DestroyRef).onDestroy(() => { this.releaseSrc(); });
  }

  protected onLoaded(video: HTMLVideoElement): void {
    const handle = this.clip.handle();
    if (handle) {
      video.currentTime = handle.startOffsetS;
      void video.play();
    }
  }

  protected onTick(video: HTMLVideoElement): void {
    const handle = this.clip.handle();
    if (!handle) return;
    const end = Math.min(handle.endOffsetS, video.duration || handle.endOffsetS);
    if (video.currentTime >= end) video.currentTime = handle.startOffsetS;
  }

  /** Footage ended before the window end (window ran to the buffer edge): restart the loop. */
  protected onEnded(video: HTMLVideoElement): void {
    const handle = this.clip.handle();
    if (handle) { video.currentTime = handle.startOffsetS; void video.play(); }
  }

  private releaseSrc(): void {
    if (this.srcUrl) URL.revokeObjectURL(this.srcUrl);
    this.srcUrl = '';
  }
}
