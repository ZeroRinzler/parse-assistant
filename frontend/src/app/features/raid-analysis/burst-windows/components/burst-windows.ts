import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { WindowComparison } from '../../../../shared/components/window-comparison/window-comparison';
import { LoadState } from '../../../../shared/components/load-state/load-state';
import { ClipAnchor } from '../../../../domain/capture/capture.models';
import { BurstFeatureService, BurstMapAnchor, BurstView } from '../facade/burst-feature-service';
import { BurstBench } from '../data-access/burst-data-source';
import { LoadResourceService } from '../../../../shared/state/load-resource-service';
import { Result } from '../../../../core/http/result';
import { WindowBuffPresence } from '../../../../domain/analysis/buff-presence-service';

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
  /** Set only by the compare page: a bench synthesized from the other log's single parse, in place of the top-parse bench. */
  readonly compareBench = input<Result<BurstBench> | null>(null);
  /** Set only by the compare page: the other log's player name, in place of "top parses" in the card copy. */
  readonly peerLabel = input<string | null>(null);
  /** Set only by the compare page: the analyzed player's own name, in place of the generic "You". */
  readonly youLabel = input<string | null>(null);
  /** Set only by the compare page: the peer's per-window buff/consumable presence, index-aligned with the bench's windows. */
  readonly peerBuffs = input<WindowBuffPresence[] | null>(null);

  protected readonly subtitle = computed(() => {
    const peer = this.peerLabel();
    return peer ? `Damage in each burst window vs ${peer}.` : 'Damage in each burst window vs top parses.';
  });

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
      compareBench: this.compareBench(),
      peerBuffs: this.peerBuffs(),
    }),
    load: (p): Promise<Result<BurstView>> => p.compareBench
      ? p.compareBench.ok
        ? this.burst.loadPlayerViewFromBench(p.compareBench.value, p.report, p.fight, p.player, p.peerBuffs)
        : Promise.resolve(p.compareBench)
      : p.report && p.fight && p.player
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
