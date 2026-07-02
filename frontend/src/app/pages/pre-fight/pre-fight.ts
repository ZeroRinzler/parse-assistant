import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatCardModule } from '@angular/material/card';
import { SelectionStore } from '../../core/services/selection-store';
import { SpecEntry, EncounterEntry } from '../../core/models/encounter.models';
import { EncounterSelectionService } from './encounter-selection.service';
import { LoadingSpinnerComponent } from '../../shared/components/loading-spinner/loading-spinner';
import { ArtIconComponent } from '../../shared/components/art-icon/art-icon';
import { FormatSpecPipe } from '../../shared/pipes/format-spec-pipe';
import { ClassIconPipe } from '../../shared/pipes/class-icon-pipe';
import { SpecIconPipe } from '../../shared/pipes/spec-icon-pipe';
import { BossIconPipe } from '../../shared/pipes/boss-icon-pipe';
import { classList, specsForClass, specMetaOf } from '../../core/spec-meta';
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
    LoadingSpinnerComponent, ArtIconComponent,
    FormatSpecPipe, ClassIconPipe, SpecIconPipe, BossIconPipe,
    RotationCdPlanComponent, DefensivePlanComponent, BurstWindowsComponent,
    GearComponent, MapPanelComponent,
  ],
  templateUrl: './pre-fight.html',
})
export class PreFightComponent implements OnInit {
  private readonly encounterSelection = inject(EncounterSelectionService);
  private readonly mapFeature = inject(MapFeatureService);
  private readonly selectionStore = inject(SelectionStore);

  // Class is chosen first; the spec select stays disabled until a class is picked, mirroring
  // how the encounter select gates on the spec.
  protected readonly classControl = new FormControl('', { nonNullable: true });
  protected readonly specControl = new FormControl<string>({ value: '', disabled: true }, { nonNullable: true });
  protected readonly encControl = new FormControl<number>({ value: 0, disabled: true }, { nonNullable: true });

  protected readonly specs = signal<SpecEntry[]>([]);
  protected readonly encounters = signal<EncounterEntry[]>([]);
  protected readonly selectedClass = toSignal(this.classControl.valueChanges, { initialValue: this.classControl.value });
  protected readonly selectedSpec = toSignal(this.specControl.valueChanges, { initialValue: this.specControl.value });
  protected readonly selectedEncId = toSignal(this.encControl.valueChanges, { initialValue: this.encControl.value });

  // Only classes that actually have ingested specs appear in the Class dropdown.
  protected readonly classes = computed(() => {
    const available = this.specs().map(entry => entry.spec);
    return classList().filter(cls => specsForClass(cls.className, available).length > 0);
  });
  // Specs belonging to the chosen class, restricted to those with ingested data.
  protected readonly specsForSelectedClass = computed(() =>
    specsForClass(this.selectedClass(), this.specs().map(entry => entry.spec)));
  // The selected encounter row, so the select trigger can render its boss icon + name.
  protected readonly selectedEncounter = computed(() =>
    this.encounters().find(entry => entry.id === this.selectedEncId()));
  protected readonly loading = signal(false);
  protected readonly error = signal('');
  // The burst-window positioning button lights up once the top-parse trails have loaded.
  protected readonly mapReady = computed(() => this.mapFeature.ready());

  protected onOpenMap(anchor: MapAnchor): void {
    this.mapFeature.openAt(anchor);
  }

  async ngOnInit(): Promise<void> {
    this.loading.set(true);
    try {
      const specs = await this.encounterSelection.getSpecs();
      this.specs.set(specs);
      if (this.classes().length) this.classControl.enable({ emitEvent: false });
    } finally {
      this.loading.set(false);
    }

    // Restore the last spec from localStorage (the only persisted pre-fight selection); the
    // class is derived from it (not stored), and the encounter is always re-selected.
    const autoSpec = this.selectionStore.loadPreFight()?.spec ?? '';
    const meta = specMetaOf(autoSpec);
    if (autoSpec && meta && this.specs().some(specEntry => specEntry.spec === autoSpec)) {
      this.classControl.setValue(meta.className);
      this.specControl.enable({ emitEvent: false });
      this.specControl.setValue(autoSpec);
      await this._onSpecSelected(autoSpec);
    }
  }

  protected onClassChange(): void {
    // A new class invalidates the spec, encounter, map, and persisted spec selection.
    // Emit so the `selectedSpec` signal (and thus the select trigger) clears - suppressing
    // the event would leave the trigger showing the now-invalid spec from the old class.
    this.specControl.setValue('', { emitEvent: true });
    this.selectionStore.savePreFight({ spec: null });
    this.mapFeature.clear();
    this.encControl.setValue(0, { emitEvent: false });
    this.encControl.disable({ emitEvent: false });
    this.encounters.set([]);
    const available = this.specs().map(entry => entry.spec);
    if (specsForClass(this.classControl.value, available).length) {
      this.specControl.enable({ emitEvent: false });
    } else {
      this.specControl.disable({ emitEvent: false });
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
    this.encounters.set(await this.encounterSelection.getEncounters(spec));
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
