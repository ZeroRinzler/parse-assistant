import { ChangeDetectionStrategy, Component, effect, inject, input, output, signal } from '@angular/core';
import { WindowComparisonComponent } from '../../../shared/components/window-comparison/window-comparison';
import { ComparisonWindow } from '../../../core/models/window-comparison.models';
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

  readonly openMap = output<BurstMapAnchor>();

  private readonly _windows = signal<ComparisonWindow[]>([]);
  private readonly _anchors = signal<BurstMapAnchor[]>([]);
  protected readonly windows = this._windows.asReadonly();

  // Bumped on every reload so a slow earlier response can't overwrite a newer one.
  private loadToken = 0;

  constructor() {
    effect(() => {
      const spec = this.spec();
      const encounterId = this.encounterId();
      const report = this.report();
      const fight = this.fight();
      const player = this.player();
      const token = ++this.loadToken;
      const load = report && fight && player
        ? this.burst.loadPlayerView(spec, encounterId, report, fight, player)
        : this.burst.loadBenchView(spec, encounterId);
      void load.then(view => {
        if (token !== this.loadToken) return;
        this._windows.set(view.windows);
        this._anchors.set(view.anchors);
      });
    });
  }

  protected onOpenMap(index: number): void {
    const anchor = this._anchors()[index];
    if (anchor) this.openMap.emit(anchor);
  }
}
