import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { MAT_FORM_FIELD_DEFAULT_OPTIONS, MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatCardModule } from '@angular/material/card';
import { SelectionStore } from '../../core/services/selection-store';
import { SpecEntry, EncounterEntry } from '../../core/models/encounter.models';
import { LoadError } from '../../core/result';
import { logWarn } from '../../core/log';
import { EncounterSelectionService } from './encounter-selection.service';
import { LoadingSpinnerComponent } from '../../shared/components/loading-spinner/loading-spinner';
import { BenchEmptyBannerComponent } from '../../shared/components/bench-empty-banner/bench-empty-banner';
import { LoadStateComponent, RenderableLoadError } from '../../shared/components/load-state/load-state';
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
import { NorthernSkyExportComponent } from '../post-raid/northern-sky/northern-sky-export';

/** Pre-fight page shell; selection is not carried in the URL - the last spec is restored from localStorage, the encounter is always re-selected. */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-pre-fight',
  imports: [
    ReactiveFormsModule, MatFormFieldModule, MatSelectModule, MatCardModule,
    LoadingSpinnerComponent, BenchEmptyBannerComponent, LoadStateComponent, ArtIconComponent,
    FormatSpecPipe, ClassIconPipe, SpecIconPipe, BossIconPipe,
    RotationCdPlanComponent, DefensivePlanComponent, BurstWindowsComponent,
    GearComponent, MapPanelComponent, NorthernSkyExportComponent,
  ],
  // Provided per lazy page so form-field stays out of the initial bundle.
  providers: [{ provide: MAT_FORM_FIELD_DEFAULT_OPTIONS, useValue: { subscriptSizing: 'dynamic' } }],
  templateUrl: './pre-fight.html',
})
export class PreFightComponent implements OnInit {
  private readonly encounterSelection = inject(EncounterSelectionService);
  private readonly mapFeature = inject(MapFeatureService);
  private readonly selectionStore = inject(SelectionStore);

  protected readonly classControl = new FormControl('', { nonNullable: true });
  protected readonly specControl = new FormControl<string>({ value: '', disabled: true }, { nonNullable: true });
  protected readonly encControl = new FormControl<number>({ value: 0, disabled: true }, { nonNullable: true });

  protected readonly specs = signal<SpecEntry[]>([]);
  protected readonly encounters = signal<EncounterEntry[]>([]);
  protected readonly selectedClass = toSignal(this.classControl.valueChanges, { initialValue: this.classControl.value });
  protected readonly selectedSpec = toSignal(this.specControl.valueChanges, { initialValue: this.specControl.value });
  protected readonly selectedEncId = toSignal(this.encControl.valueChanges, { initialValue: this.encControl.value });

  protected readonly classes = computed(() => {
    const available = this.specs().map(entry => entry.spec);
    return classList().filter(cls => specsForClass(cls.className, available).length > 0);
  });
  protected readonly specsForSelectedClass = computed(() =>
    specsForClass(this.selectedClass(), this.specs().map(entry => entry.spec)));
  protected readonly selectedEncounter = computed(() =>
    this.encounters().find(entry => entry.id === this.selectedEncId()));
  protected readonly loading = signal(false);
  protected readonly error = signal<RenderableLoadError | null>(null);

  // Init true avoids a one-frame banner flash on a benched encounter (pre-fight cards render with no reveal gate).
  protected readonly gearAvailable = signal(true);
  protected readonly cdPlanAvailable = signal(true);
  protected readonly defensivePlanAvailable = signal(true);
  protected readonly burstAvailable = signal(true);
  protected readonly northernSkyAvailable = signal(true);
  protected readonly benchAvailable = computed(() =>
    this.gearAvailable() || this.cdPlanAvailable() || this.defensivePlanAvailable()
    || this.burstAvailable() || this.northernSkyAvailable());

  protected readonly mapReady = this.mapFeature.ready;

  protected onOpenMap(anchor: MapAnchor): void {
    this.mapFeature.openAt(anchor);
  }

  async ngOnInit(): Promise<void> {
    this.loading.set(true);
    try {
      const specs = await this.encounterSelection.getSpecs();
      if (specs.ok) {
        this.specs.set(specs.value);
        if (this.classes().length) this.classControl.enable({ emitEvent: false });
      } else {
        this.surfaceLoadError(specs.error);
      }
    } finally {
      this.loading.set(false);
    }

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
    // Emit so the selectedSpec signal (and select trigger) clears; suppressing it would leave the trigger showing the now-invalid spec from the old class.
    this.specControl.setValue('', { emitEvent: true });
    this.selectionStore.savePreFight({ spec: null });
    this.mapFeature.clear();
    // selectedEncId mirrors valueChanges; emit so the reset closes the encounter-gated cards.
    this.encControl.setValue(0, { emitEvent: true });
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
    // selectedEncId mirrors valueChanges; emit so the reset closes the encounter-gated cards.
    this.encControl.setValue(0, { emitEvent: true });
    this.encControl.disable({ emitEvent: false });
    this.encounters.set([]);
    if (!spec) return;
    await this._onSpecSelected(spec);
  }

  private async _onSpecSelected(spec: string): Promise<void> {
    this.error.set(null);
    const encounters = await this.encounterSelection.getEncounters(spec);
    if (!encounters.ok) {
      this.surfaceLoadError(encounters.error);
      this.encControl.disable({ emitEvent: false });
      return;
    }
    this.encounters.set(encounters.value);
    if (this.encounters().length) {
      this.encControl.enable({ emitEvent: false });
    } else {
      this.encControl.disable({ emitEvent: false });
    }
  }

  private surfaceLoadError(error: LoadError): void {
    if (error.kind === 'permanent') logWarn(error.id, error.context);
    this.error.set(error.kind === 'missing' ? null : error);
  }

  protected async onEncChange(): Promise<void> {
    const encId = this.encControl.value;
    const spec = this.specControl.value;
    this.mapFeature.clear();
    if (!encId || !spec) return;
    void this.mapFeature.loadBench(spec, encId);
  }
}
