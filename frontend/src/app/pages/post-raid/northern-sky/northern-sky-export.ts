import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal } from '@angular/core';
import { Clipboard } from '@angular/cdk/clipboard';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { FlyoverPanelComponent } from '../../../shared/components/flyover-panel/flyover-panel';
import { GameIconComponent } from '../../../shared/components/game-icon/game-icon';
import { SelectionStore } from '../../../core/services/selection-store';
import { LatestLoad } from '../../../shared/latest-load';
import { NorthernSkyBench } from './northern-sky-data-source';
import {
  NorthernSkyFeatureService, buildNorthernSkyNote, abilitiesByKind, selectedIds, isAllSelected,
  toggleExclusion, toggleAllExclusion,
} from './northern-sky.service';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-northern-sky-export',
  imports: [MatButtonModule, MatIconModule, MatCheckboxModule, FlyoverPanelComponent, GameIconComponent],
  templateUrl: './northern-sky-export.html',
})
export class NorthernSkyExportComponent {
  private readonly feature = inject(NorthernSkyFeatureService);
  private readonly selection = inject(SelectionStore);
  private readonly clipboard = inject(Clipboard);

  readonly spec = input.required<string>();
  readonly encounterId = input.required<number>();
  /** Emits whether the export bench exists, so the page can aggregate it for the banner. */
  readonly availableChange = output<boolean>();

  private readonly bench = signal<NorthernSkyBench | null>(null);
  private readonly excluded = signal<ReadonlySet<number>>(new Set(this.selection.loadNorthernSky()?.excludedSpellIds ?? []));
  protected readonly open = signal(false);
  protected readonly copied = signal(false);

  protected readonly abilities = computed(() => this.bench()?.abilities ?? []);
  private readonly grouped = computed(() => abilitiesByKind(this.abilities()));
  protected readonly cooldowns = computed(() => this.grouped().cooldowns);
  protected readonly defensives = computed(() => this.grouped().defensives);
  protected readonly available = computed(() => this.abilities().length > 0);
  protected readonly allSelected = computed(() => isAllSelected(this.abilities(), this.excluded()));

  private readonly loader = new LatestLoad();

  constructor() {
    effect(() => {
      const spec = this.spec();
      const encounterId = this.encounterId();
      this.loader.run(this.feature.getExport(spec, encounterId), {
        context: 'northernSky.getExport',
        apply: result => {
          this.bench.set(result.ok ? result.value : null);
          this.availableChange.emit(this.available());
        },
      });
    });
  }

  protected isSelected(spellId: number): boolean {
    return !this.excluded().has(spellId);
  }

  protected toggle(spellId: number, checked: boolean): void {
    this.persist(toggleExclusion(this.excluded(), spellId, checked));
  }

  protected toggleAll(): void {
    this.persist(toggleAllExclusion(this.abilities(), this.excluded()));
  }

  protected copyNote(): void {
    const bench = this.bench();
    if (!bench) return;
    this.clipboard.copy(buildNorthernSkyNote(bench, selectedIds(this.abilities(), this.excluded())));
    this.copied.set(true);
  }

  protected openPanel(): void {
    this.copied.set(false);
    this.open.set(true);
  }

  private persist(excluded: ReadonlySet<number>): void {
    this.excluded.set(excluded);
    this.selection.saveNorthernSky({ excludedSpellIds: [...excluded] });
  }
}
