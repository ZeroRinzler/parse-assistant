import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { ClipAnchor } from '../../../../domain/capture/capture.models';
import {
  FindingRow, FindingTable,
} from '../../../../shared/components/finding-table/finding-table';
import { FindingRowsService } from '../../../../shared/components/finding-table/finding-rows-service';
import { WindowComparison } from '../../../../shared/components/window-comparison/window-comparison';
import { LoadState } from '../../../../shared/components/load-state/load-state';
import { DefensiveFeatureService, DefensiveMapAnchor } from '../facade/defensive-feature-service';
import { LoadResourceService } from '../../../../shared/state/load-resource-service';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-defensive',
  imports: [FindingTable, WindowComparison, LoadState],
  templateUrl: './defensive.html',
})
export class Defensive {
  private readonly loadRes = inject(LoadResourceService);
  private readonly rowBuilder = inject(FindingRowsService);
  private readonly defensive = inject(DefensiveFeatureService);

  readonly spec = input.required<string>();
  readonly encounterId = input.required<number>();
  readonly report = input.required<string>();
  readonly fight = input.required<number>();
  readonly player = input.required<number>();
  /** Map button is available once the page has loaded top-parse positions. */
  readonly showMap = input<boolean>(false);
  /** Clip button is available once the page's rolling buffer covers this fight. */
  readonly showClip = input<boolean>(false);

  readonly openMap = output<DefensiveMapAnchor>();
  readonly openClip = output<ClipAnchor>();
  /** Emits false when the card has finished loading; the page gates its spinner on it. */
  readonly busyChange = output<boolean>();
  /** Whether the top-parse bench exists. The page aggregates it for the banner. */
  readonly availableChange = output<boolean>();

  private readonly load = this.loadRes.loadResource({
    params: () => ({
      spec: this.spec(),
      encounterId: this.encounterId(),
      report: this.report(),
      fight: this.fight(),
      player: this.player(),
    }),
    load: p => this.defensive.loadAnalysisView(p.spec, p.encounterId, p.report, p.fight, p.player),
    context: 'defensive.loadAnalysisView',
    initialAvailable: true,
    busyChange: this.busyChange,
    availableChange: this.availableChange,
  });

  protected readonly available = this.load.available;
  protected readonly error = this.load.error;
  protected readonly windows = computed(() => this.load.value()?.windows ?? []);
  private readonly anchors = computed<DefensiveMapAnchor[]>(() => this.load.value()?.anchors ?? []);
  private readonly clipAnchors = computed<ClipAnchor[]>(() => this.load.value()?.clipAnchors ?? []);

  private readonly entries = computed(() => {
    const view = this.load.value();
    const spellIds = view?.spellIdsByName ?? {};
    const icons = view?.iconByName ?? {};
    return this.rowBuilder.bucketFindings(view?.findings ?? [], {
      spellId: name => spellIds[name] ?? null,
      icon: name => icons[name] ?? '',
    });
  });

  protected readonly findingRows = computed<FindingRow[]>(() => this.rowBuilder.rowsFromEntries(this.entries()));
  protected readonly onPlan = computed(() => this.rowBuilder.onPlanFromEntries(this.entries()));

  protected onOpenMap(index: number): void {
    const anchor = this.anchors()[index];
    if (anchor) this.openMap.emit(anchor);
  }

  protected onOpenClip(index: number): void {
    const anchor = this.clipAnchors()[index];
    if (anchor) this.openClip.emit(anchor);
  }

  /** A timed finding's map button: open the map at that cast time (boss reference). */
  protected onFindingMap(row: FindingRow): void {
    if (row.timestampS == null) return;
    this.openMap.emit({
      timeS: row.timestampS,
      refGameId: null,
    });
  }

  /** A timed finding's clip button: a clip centered on that cast instant (roll on each side). */
  protected onFindingClip(row: FindingRow): void {
    if (row.timestampS == null) return;
    this.openClip.emit(this.defensive.defensiveFindingClipAnchor(row.timestampS));
  }
}
