import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatCardModule } from '@angular/material/card';
import { DataFileApiService } from '../../core/services/data-file-api';
import { SelectionStore } from '../../core/services/selection-store';
import { SpecEntry, EncounterEntry } from '../../core/models/encounter.models';
import { LoadingSpinnerComponent } from '../../shared/components/loading-spinner/loading-spinner';
import { FormatSpecPipe } from '../../shared/pipes/format-spec-pipe';
import { RotationCdPlanComponent } from '../post-raid/rotation/rotation-cd-plan';
import { DefensivePlanComponent } from '../post-raid/defensive/defensive-plan';
import { BurstWindowsComponent } from '../post-raid/burst-windows/burst-windows';
import { GearComponent } from '../post-raid/gear/gear';
import { MapPanelComponent } from '../post-raid/map/map-panel';
import { MapFeatureService, MapAnchor } from '../post-raid/map/map.service';

/**
 * Pre-fight gear/plan page shell. It owns only spec + encounter selection - no domain
 * analysis. Each feature card reads its own bench-only slice from the swappable data
 * source: the cooldown + defensive plans, the bench burst windows, and the gear
 * consensus. The map renders top-parse trails; opening it from a card's `openMap`
 * output is forwarded to the `MapFeatureService`.
 *
 * Selection is not carried in the URL. The last spec is restored from localStorage; the
 * encounter is always re-selected.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-pre-fight',
  imports: [
    ReactiveFormsModule, MatFormFieldModule, MatSelectModule, MatCardModule,
    LoadingSpinnerComponent, FormatSpecPipe,
    RotationCdPlanComponent, DefensivePlanComponent, BurstWindowsComponent,
    GearComponent, MapPanelComponent,
  ],
  templateUrl: './pre-fight.html',
})
export class PreFightComponent implements OnInit {
  private readonly files = inject(DataFileApiService);
  private readonly mapFeature = inject(MapFeatureService);
  private readonly selectionStore = inject(SelectionStore);

  protected readonly specControl = new FormControl('', { nonNullable: true });
  protected readonly encControl = new FormControl<number>({ value: 0, disabled: true }, { nonNullable: true });

  protected readonly specs = signal<SpecEntry[]>([]);
  protected readonly encounters = signal<EncounterEntry[]>([]);
  protected readonly selectedSpec = toSignal(this.specControl.valueChanges, { initialValue: this.specControl.value });
  protected readonly selectedEncId = toSignal(this.encControl.valueChanges, { initialValue: this.encControl.value });
  protected readonly loading = signal(false);
  protected readonly error = signal('');

  protected onOpenMap(anchor: MapAnchor): void {
    this.mapFeature.openAt(anchor);
  }

  async ngOnInit(): Promise<void> {
    this.loading.set(true);
    try {
      const specs = await this.files.getSpecs();
      this.specs.set(specs);
      if (specs.length) this.specControl.enable({ emitEvent: false });
    } finally {
      this.loading.set(false);
    }

    // Restore the last spec from localStorage (the only persisted pre-fight selection); the
    // encounter is always re-selected.
    const autoSpec = this.selectionStore.loadPreFight()?.spec ?? '';
    if (autoSpec && this.specs().some(specEntry => specEntry.spec === autoSpec)) {
      this.specControl.setValue(autoSpec);
      await this._onSpecSelected(autoSpec);
    }
  }

  protected async onSpecChange(): Promise<void> {
    const spec = this.specControl.value;
    this.selectionStore.savePreFight({ spec: spec || null });
    this.mapFeature.clear();
    this.encControl.setValue(0, { emitEvent: false });
    this.encControl.disable({ emitEvent: false });
    this.encounters.set([]);
    if (!spec) return;
    await this._onSpecSelected(spec);
  }

  private async _onSpecSelected(spec: string): Promise<void> {
    const enc = await this.files.getEncounters(spec);
    this.encounters.set(enc.filter(entry => entry.sample_count > 0));
    if (this.encounters().length) {
      this.encControl.enable({ emitEvent: false });
    } else {
      this.encControl.disable({ emitEvent: false });
    }
  }

  protected async onEncChange(): Promise<void> {
    const encId = this.encControl.value;
    const spec = this.specControl.value;
    this.mapFeature.clear();
    if (!encId || !spec) return;
    // Load the top-parse position trails for the map (bench-only, no player log).
    void this.mapFeature.loadBench(spec, encId);
  }
}
