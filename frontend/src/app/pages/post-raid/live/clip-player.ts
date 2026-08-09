import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, effect, inject, viewChild } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { ClipHandle, LiveCaptureFeatureService, pipeIntoElement, releaseElement } from './live-capture.service';

/** MediaSource must attach to a real element to open, so assembly happens here, not in the service. */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-clip-player',
  imports: [MatButtonModule, MatIconModule],
  templateUrl: './clip-player.html',
})
export class ClipPlayerComponent {
  protected readonly clip = inject(LiveCaptureFeatureService);
  private readonly player = viewChild<ElementRef<HTMLVideoElement>>('player');

  /** The handle already piped into the element, so an effect re-fire never re-stitches it. */
  private piped: ClipHandle | null = null;
  /** The element last piped into, so its blob src can be released on destroy. */
  private pipedEl: HTMLVideoElement | null = null;

  constructor() {
    effect(() => {
      const handle = this.clip.handle();
      const el = this.player()?.nativeElement;
      if (!handle || !el || this.piped === handle) return;
      this.piped = handle;
      this.pipedEl = el;
      void pipeIntoElement(el, handle.blobs, handle.mimeType);
    });
    // pipeIntoElement releases the previous URL on each re-pipe; this releases the last one.
    inject(DestroyRef).onDestroy(() => {
      if (this.pipedEl) releaseElement(this.pipedEl);
    });
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
}
