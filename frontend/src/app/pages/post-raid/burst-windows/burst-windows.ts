import { ChangeDetectionStrategy, Component, effect, inject, input, output, signal } from '@angular/core';
import { WindowComparisonComponent } from '../../../shared/components/window-comparison/window-comparison';
import { LoadStateComponent, RenderableLoadError } from '../../../shared/components/load-state/load-state';
import { ComparisonWindow } from '../../../core/models/window-comparison.models';
import { ClipAnchor } from '../../../core/models/capture.models';
import { logWarn } from '../../../core/log';
import { LatestLoad } from '../../../shared/latest-load';
import { BurstFeatureService, BurstMapAnchor } from './burst.service';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-burst-windows',
  imports: [WindowComparisonComponent, LoadStateComponent],
  templateUrl: './burst-windows.html',
})
export class BurstWindowsComponent {
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

  protected readonly available = signal(true);
  protected readonly error = signal<RenderableLoadError | null>(null);
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
        apply: result => {
          if (result.ok) {
            this.error.set(null);
            this.available.set(true);
            this.availableChange.emit(true);
            this._windows.set(result.value.windows);
            this._anchors.set(result.value.anchors);
            this._clipAnchors.set(result.value.clipAnchors);
          } else {
            if (result.error.kind === 'permanent') logWarn(result.error.id, result.error.context);
            this.error.set(result.error.kind === 'missing' ? null : result.error);
            this.available.set(false);
            this.availableChange.emit(false);
            this._windows.set([]);
            this._anchors.set([]);
            this._clipAnchors.set([]);
          }
        },
        settled: () => { this.busyChange.emit(false); },
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
