import { ChangeDetectionStrategy, Component, effect, inject, input, output, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { WclFight } from '../../../core/models/wcl.models';
import { ClipAnchor } from '../../../core/models/capture.models';
import { MapAnchor } from '../map/map.service';
import { LatestLoad } from '../../../shared/latest-load';
import { FormatDurationPipe } from '../../../shared/pipes/format-duration-pipe';
import { FormatDamagePipe } from '../../../shared/pipes/format-damage-pipe';
import { PullOverviewFeatureService, PullOverviewView } from './pull-overview.service';

/**
 * Pull overview card - the first card on the post-raid page. A feature component: it injects
 * exactly one service (`PullOverviewFeatureService`) and renders a single pull's summary from
 * the player's own log. It needs no bench, so it is always available (no `availableChange`).
 * The per-row positioning / rewatch actions are outputs the page forwards to the map / clip
 * flyovers; the positioning button shows once the fight has bench positions (`showMap`), the
 * rewatch button once the rolling buffer covers the fight (`showClip`) - same as the other cards.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-pull-overview',
  imports: [DecimalPipe, MatIconModule, MatButtonModule, FormatDurationPipe, FormatDamagePipe],
  templateUrl: './pull-overview.html',
  host: { class: 'block' },
})
export class PullOverviewComponent {
  private readonly service = inject(PullOverviewFeatureService);

  readonly report = input.required<string>();
  readonly player = input.required<number>();
  readonly fight = input.required<WclFight>();
  /** Positioning button is enabled once the page has loaded top-parse positions (bench). */
  readonly showMap = input<boolean>(false);
  /** Rewatch button is enabled once the page's rolling buffer covers this fight. */
  readonly showClip = input<boolean>(false);

  readonly openMap = output<MapAnchor>();
  readonly openClip = output<ClipAnchor>();
  /** Emits false when the card has finished loading; the page gates its spinner on it. */
  readonly busyChange = output<boolean>();

  private readonly _view = signal<PullOverviewView | null>(null);
  protected readonly view = this._view.asReadonly();

  private readonly loader = new LatestLoad();

  constructor() {
    effect(() => {
      const report = this.report();
      const player = this.player();
      const fight = this.fight();
      this.loader.run(this.service.loadView(report, player, fight), {
        context: 'pull-overview.loadView',
        apply: view => this._view.set(view),
        settled: () => this.busyChange.emit(false),
      });
    });
  }

  protected onOpenMap(timeS: number): void {
    this.openMap.emit({ timeS, windowLengthS: 0 });
  }

  protected onOpenClip(timeS: number, key: string): void {
    this.openClip.emit({ timeS, windowLengthS: 0, key });
  }
}
