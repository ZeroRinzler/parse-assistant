import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal } from '@angular/core';
import { AnalysisFinding } from '../../../core/models/analysis.models';
import { ComparisonWindow } from '../../../core/models/window-comparison.models';
import { ClipAnchor } from '../../../core/models/capture.models';
import {
  bucketFindings, CAT_LABEL, FindingRow, FindingTableComponent, onPlanFromEntries, rowsFromEntries,
} from '../../../shared/components/finding-table/finding-table';
import { WindowComparisonComponent } from '../../../shared/components/window-comparison/window-comparison';
import { LoadStateComponent, RenderableLoadError } from '../../../shared/components/load-state/load-state';
import { LatestLoad } from '../../../shared/latest-load';
import { logWarn } from '../../../core/log';
import { DefensiveFeatureService, DefensiveMapAnchor, defensiveFindingClipAnchor } from './defensive.service';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-defensive',
  imports: [FindingTableComponent, WindowComparisonComponent, LoadStateComponent],
  templateUrl: './defensive.html',
})
export class DefensiveComponent {
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

  protected readonly available = signal(true);
  protected readonly error = signal<RenderableLoadError | null>(null);
  private readonly _findings = signal<AnalysisFinding[]>([]);
  private readonly _spellIdsByName = signal<Record<string, number>>({});
  private readonly _iconByName = signal<Record<string, string>>({});
  private readonly _windows = signal<ComparisonWindow[]>([]);
  private readonly _anchors = signal<DefensiveMapAnchor[]>([]);
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
      this.loader.run(this.defensive.loadAnalysisView(spec, encounterId, report, fight, player), {
        context: 'defensive.loadAnalysisView',
        apply: result => {
          if (result.ok) {
            const view = result.value;
            this.error.set(null);
            this.available.set(true);
            this.availableChange.emit(true);
            this._findings.set(view.findings);
            this._spellIdsByName.set(view.spellIdsByName);
            this._iconByName.set(view.iconByName);
            this._windows.set(view.windows);
            this._anchors.set(view.anchors);
            this._clipAnchors.set(view.clipAnchors);
          } else {
            if (result.error.kind === 'permanent') logWarn(result.error.id, result.error.context);
            this.error.set(result.error.kind === 'missing' ? null : result.error);
            this.available.set(false);
            this.availableChange.emit(false);
            this._findings.set([]);
            this._spellIdsByName.set({});
            this._iconByName.set({});
            this._windows.set([]);
            this._anchors.set([]);
            this._clipAnchors.set([]);
          }
        },
        settled: () => this.busyChange.emit(false),
      });
    });
  }

  private readonly entries = computed(() => {
    const spellIds = this._spellIdsByName();
    const icons = this._iconByName();
    return bucketFindings(this._findings(), {
      spellId: name => spellIds[name] ?? null,
      icon: name => icons[name],
    });
  });

  protected readonly findingRows = computed<FindingRow[]>(() => rowsFromEntries(this.entries(), CAT_LABEL));
  protected readonly onPlan = computed(() => onPlanFromEntries(this.entries()));

  protected onOpenMap(index: number): void {
    const anchor = this._anchors()[index];
    if (anchor) this.openMap.emit(anchor);
  }

  protected onOpenClip(index: number): void {
    const anchor = this._clipAnchors()[index];
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
    this.openClip.emit(defensiveFindingClipAnchor(row.timestampS));
  }
}
