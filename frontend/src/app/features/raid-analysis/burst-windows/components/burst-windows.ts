import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { WindowComparison } from '../../../../shared/components/window-comparison/window-comparison';
import { LoadState } from '../../../../shared/components/load-state/load-state';
import { ClipAnchor } from '../../../../domain/capture/capture.models';
import { BurstFeatureService, BurstMapAnchor } from '../facade/burst-feature-service';
import { LoadResourceService } from '../../../../shared/state/load-resource-service';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-burst-windows',
  imports: [WindowComparison, LoadState],
  templateUrl: './burst-windows.html',
})
export class BurstWindows {
  private readonly loadRes = inject(LoadResourceService);
  private readonly burst = inject(BurstFeatureService);

  readonly spec = input.required<string>();
  readonly encounterId = input.required<number>();
  readonly report = input<string>('');
  readonly fight = input<number>(0);
  readonly player = input<number>(0);
  readonly showMap = input<boolean>(false);
  readonly showClip = input<boolean>(false);

  readonly openMap = output<BurstMapAnchor>();
  readonly openClip = output<ClipAnchor>();
  readonly busyChange = output<boolean>();
  readonly availableChange = output<boolean>();

  private readonly load = this.loadRes.loadResource({
    params: () => ({
      spec: this.spec(),
      encounterId: this.encounterId(),
      report: this.report(),
      fight: this.fight(),
      player: this.player(),
    }),
    load: p => p.report && p.fight && p.player
      ? this.burst.loadPlayerView(p.spec, p.encounterId, p.report, p.fight, p.player)
      : this.burst.loadBenchView(p.spec, p.encounterId),
    context: 'burst.loadPlayerView',
    initialAvailable: true,
    busyChange: this.busyChange,
    availableChange: this.availableChange,
  });

  protected readonly available = this.load.available;
  protected readonly error = this.load.error;
  protected readonly windows = computed(() => this.load.value()?.windows ?? []);
  private readonly anchors = computed<BurstMapAnchor[]>(() => this.load.value()?.anchors ?? []);
  private readonly clipAnchors = computed<ClipAnchor[]>(() => this.load.value()?.clipAnchors ?? []);

  protected onOpenMap(index: number): void {
    const anchor = this.anchors()[index];
    if (anchor) this.openMap.emit(anchor);
  }

  protected onOpenClip(index: number): void {
    const anchor = this.clipAnchors()[index];
    if (anchor) this.openClip.emit(anchor);
  }
}
