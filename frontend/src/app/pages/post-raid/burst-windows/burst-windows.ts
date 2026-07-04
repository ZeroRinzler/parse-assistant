import { ChangeDetectionStrategy, Component, effect, inject, input, output, signal } from '@angular/core';
import { WindowComparisonComponent } from '../../../shared/components/window-comparison/window-comparison';
import { ComparisonWindow } from '../../../core/models/window-comparison.models';
import { ClipAnchor } from '../../../core/models/capture.models';
import { LatestLoad } from '../../../shared/latest-load';
import { BurstFeatureService, BurstMapAnchor } from './burst.service';

/**
 * Burst card. A feature component: it injects exactly one service
 * (`BurstFeatureService`) and renders. Its bench windows come from the swappable
 * `BURST_DATA_SOURCE` (file in prod, live transform under the dev flag); the
 * player's window damage is computed by the service from the player's own log.
 *
 * Dual-mode: with a `report`/`fight`/`player` selection (post-raid) it compares the
 * player against the bench; with only `spec`/`encounterId` (pre-fight) it shows the
 * bench windows informationally. Opening the map is an output the page wires.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-burst-windows',
  imports: [WindowComparisonComponent],
  templateUrl: './burst-windows.html',
})
export class BurstWindowsComponent {
  private readonly burst = inject(BurstFeatureService);

  readonly spec = input.required<string>();
  readonly encounterId = input.required<number>();
  /** Post-raid selection - omit (or leave 0/'') for the pre-fight bench-only view. */
  readonly report = input<string>('');
  readonly fight = input<number>(0);
  readonly player = input<number>(0);
  /** Map button is available once the page has loaded top-parse positions. */
  readonly showMap = input<boolean>(false);
  /** Clip button is available once the page's rolling buffer covers this fight. */
  readonly showClip = input<boolean>(false);

  readonly openMap = output<BurstMapAnchor>();
  readonly openClip = output<ClipAnchor>();
  /** Emits false when the card has finished loading; the page gates its spinner on it. */
  readonly busyChange = output<boolean>();

  private readonly _windows = signal<ComparisonWindow[]>([]);
  private readonly _anchors = signal<BurstMapAnchor[]>([]);
  private readonly _clipAnchors = signal<ClipAnchor[]>([]);
  protected readonly windows = this._windows.asReadonly();

  private readonly loader = new LatestLoad();

  constructor() {
    effect(() => {
      const spec = this.spec();
      const encounterId = this.encounterId();
      const report = this.report();
      const fight = this.fight();
      const player = this.player();
      const load = report && fight && player
        ? this.burst.loadPlayerView(spec, encounterId, report, fight, player)
        : this.burst.loadBenchView(spec, encounterId);
      this.loader.run(load, {
        context: 'burst.loadPlayerView',
        apply: view => {
          this._windows.set(view.windows);
          this._anchors.set(view.anchors);
          this._clipAnchors.set(view.clipAnchors);
        },
        settled: () => this.busyChange.emit(false),
      });
    });
  }

  protected onOpenMap(index: number): void {
    const anchor = this._anchors()[index];
    if (anchor) this.openMap.emit(anchor);
  }

  protected onOpenClip(index: number): void {
    const anchor = this._clipAnchors()[index];
    if (anchor) this.openClip.emit(anchor);
  }
}
