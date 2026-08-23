import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { Clipboard } from '@angular/cdk/clipboard';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { FlyoverPanel } from '../../../../shared/components/flyover-panel/flyover-panel';
import { GameIcon } from '../../../../shared/components/game-icon/game-icon';
import { LoadState } from '../../../../shared/components/load-state/load-state';
import { SelectionStore } from '../../../../core/state/selection-store';
import { NorthernSkyBench } from '../data-access/northern-sky-data-source';
import { NorthernSkyFeatureService } from '../facade/northern-sky-feature-service';
import { LoadResourceService } from '../../../../shared/state/load-resource-service';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-northern-sky-export',
  imports: [MatButtonModule, MatIconModule, MatCheckboxModule, FlyoverPanel, GameIcon, LoadState],
  templateUrl: './northern-sky-export.html',
})
export class NorthernSkyExport {
  private readonly loadRes = inject(LoadResourceService);
  private readonly feature = inject(NorthernSkyFeatureService);
  private readonly selection = inject(SelectionStore);
  private readonly clipboard = inject(Clipboard);

  readonly spec = input.required<string>();
  readonly encounterId = input.required<number>();
  readonly busyChange = output<boolean>();
  readonly availableChange = output<boolean>();

  private readonly load = this.loadRes.loadResource({
    params: () => ({ spec: this.spec(), encounterId: this.encounterId() }),
    load: ({ spec, encounterId }) => this.feature.getExport(spec, encounterId),
    context: 'northernSky.getExport',
    availableWhen: (bench: NorthernSkyBench) => bench.abilities.length > 0,
    busyChange: this.busyChange,
    availableChange: this.availableChange,
  });

  private readonly bench = this.load.value;
  private readonly excluded = signal<ReadonlySet<number>>(new Set(this.selection.loadNorthernSky()?.excludedSpellIds ?? []));
  protected readonly open = signal(false);
  protected readonly copied = signal(false);
  protected readonly copyFailed = signal(false);
  protected readonly error = this.load.error;

  protected readonly abilities = computed(() => this.bench()?.abilities ?? []);
  private readonly grouped = computed(() => this.feature.abilitiesByKind(this.abilities()));
  protected readonly cooldowns = computed(() => this.grouped().cooldowns);
  protected readonly defensives = computed(() => this.grouped().defensives);
  protected readonly available = this.load.available;
  protected readonly allSelected = computed(() => this.feature.isAllSelected(this.abilities(), this.excluded()));
  protected readonly panelOpen = computed(() => this.feature.isPanelOpen(this.open(), this.available()));

  protected isSelected(spellId: number): boolean {
    return !this.excluded().has(spellId);
  }

  protected toggle(spellId: number, checked: boolean): void {
    this.persist(this.feature.toggleExclusion(this.excluded(), spellId, checked));
  }

  protected toggleAll(): void {
    this.persist(this.feature.toggleAllExclusion(this.abilities(), this.excluded()));
  }

  protected copyNote(): void {
    const bench = this.bench();
    if (!bench) return;
    const succeeded = this.clipboard.copy(this.feature.buildNorthernSkyNote(bench, this.feature.selectedIds(this.abilities(), this.excluded())));
    this.copied.set(succeeded);
    this.copyFailed.set(!succeeded);
  }

  protected openPanel(): void {
    this.copied.set(false);
    this.copyFailed.set(false);
    this.open.set(true);
  }

  private persist(excluded: ReadonlySet<number>): void {
    this.excluded.set(excluded);
    this.selection.saveNorthernSky({ excludedSpellIds: [...excluded] });
  }
}
