import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal } from '@angular/core';
import { AnalysisFinding } from '../../../core/models/analysis.models';
import { ComparisonWindow, WindowSpell } from '../../../core/models/window-comparison.models';
import {
  bucketFindings, CAT_LABEL, FindingRow, FindingTableComponent, onPlanFromEntries, rowsFromEntries,
} from '../../../shared/components/finding-table/finding-table';
import { WindowComparisonComponent } from '../../../shared/components/window-comparison/window-comparison';
import { LatestLoad } from '../../../shared/latest-load';
import { DefensiveFeatureService, DefensiveMapAnchor } from './defensive.service';

/**
 * Defensive card. A feature component: it injects exactly one service
 * (`DefensiveFeatureService`) and renders. Findings + defensive windows are computed
 * from the player's own log against the bench read via the swappable
 * `DEFENSIVE_DATA_SOURCE`; opening the map is an output the page wires.
 *
 * The findings table rows are a pure presentational derivation built from the shared
 * `finding-table` utils, mirroring the legacy section.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-defensive',
  imports: [FindingTableComponent, WindowComparisonComponent],
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
  readonly fightDuration = input<number>(0);

  readonly openMap = output<DefensiveMapAnchor>();
  /** Emits false when the card has finished loading; the page gates its spinner on it. */
  readonly busyChange = output<boolean>();

  private readonly _findings = signal<AnalysisFinding[]>([]);
  private readonly _spellIdsByName = signal<Record<string, number>>({});
  private readonly _iconByName = signal<Record<string, string>>({});
  private readonly _windows = signal<ComparisonWindow[]>([]);
  private readonly _anchors = signal<DefensiveMapAnchor[]>([]);
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
        apply: view => {
          this._findings.set(view.findings);
          this._spellIdsByName.set(view.spellIdsByName);
          this._iconByName.set(view.iconByName);
          this._windows.set(view.windows);
          this._anchors.set(view.anchors);
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
    }).entries;
  });

  protected readonly findingRows = computed<FindingRow[]>(() => rowsFromEntries(this.entries(), CAT_LABEL));
  protected readonly onPlan = computed(() => onPlanFromEntries(this.entries()));

  protected onOpenMap(index: number): void {
    const anchor = this._anchors()[index];
    if (anchor) this.openMap.emit(anchor);
  }

  /** A timed finding's map button: open the map at that cast time (boss reference). */
  protected onFindingMap(row: FindingRow): void {
    if (row.timestampMs == null) return;
    const spells: WindowSpell[] = row.spellId != null && row.name != null
      ? [{ id: row.spellId, icon: row.icon, name: row.name }]
      : [];
    this.openMap.emit({
      timeS: row.timestampMs / 1000,
      label: row.name ?? 'Defensive',
      spells,
      refGameId: null,
    });
  }
}
