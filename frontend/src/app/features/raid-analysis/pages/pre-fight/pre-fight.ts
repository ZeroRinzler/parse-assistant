import { ChangeDetectionStrategy, Component, OnInit, PendingTasks, computed, effect, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { MAT_FORM_FIELD_DEFAULT_OPTIONS, MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatCardModule } from '@angular/material/card';
import { SelectionStore } from '../../../../core/state/selection-store';
import { SpecEntry, EncounterEntry } from '../../../../domain/encounter/encounter.models';
import { LoadError } from '../../../../core/http/result';
import { EncounterSelectionService } from './encounter-selection-service';
import { LoadingSpinner } from '../../../../shared/components/loading-spinner/loading-spinner';
import { BenchEmptyBanner } from '../../../../shared/components/bench-empty-banner/bench-empty-banner';
import { LoadState, RenderableLoadError } from '../../../../shared/components/load-state/load-state';
import { ArtIcon } from '../../../../shared/components/art-icon/art-icon';
import { CardDeck, CardEntry } from '../../../../shared/state/card-deck';
import { FormatSpecPipe } from '../../../../shared/pipes/format-spec-pipe';
import { ClassIconPipe } from '../../../../shared/pipes/class-icon-pipe';
import { SpecIconPipe } from '../../../../shared/pipes/spec-icon-pipe';
import { BossIconPipe } from '../../../../shared/pipes/boss-icon-pipe';
import { SpecMetaService } from '../../../../core/data-files/spec-meta-service';
import { RotationCdPlan } from '../../rotation/components/rotation-cd-plan';
import { DefensivePlan } from '../../defensive/components/defensive-plan';
import { BurstWindows } from '../../burst-windows/components/burst-windows';
import { Gear } from '../../gear/components/gear';
import { MapPanel } from '../../map/components/map-panel';
import { MapFeatureService, MapAnchor } from '../../map/facade/map-feature-service';
import { NorthernSkyExport } from '../../northern-sky/components/northern-sky-export';
import { LoggerService } from '../../../../core/observability/logger-service';

export type PreFightCardId = 'northernSky' | 'gear' | 'cdPlan' | 'defensivePlan' | 'burst';

export const PRE_FIGHT_CARDS: readonly CardEntry<PreFightCardId>[] = [
  { id: 'northernSky', hasBench: true },
  { id: 'gear', hasBench: true },
  { id: 'cdPlan', hasBench: true },
  { id: 'defensivePlan', hasBench: true },
  { id: 'burst', hasBench: true },
];

/** Pre-fight page shell; selection is not carried in the URL - the last spec is restored from localStorage, the encounter is always re-selected. */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-pre-fight',
  imports: [
    ReactiveFormsModule, MatFormFieldModule, MatSelectModule, MatCardModule,
    LoadingSpinner, BenchEmptyBanner, LoadState, ArtIcon,
    FormatSpecPipe, ClassIconPipe, SpecIconPipe, BossIconPipe,
    RotationCdPlan, DefensivePlan, BurstWindows,
    Gear, MapPanel, NorthernSkyExport,
  ],
  // Provided per lazy page so form-field stays out of the initial bundle.
  providers: [{ provide: MAT_FORM_FIELD_DEFAULT_OPTIONS, useValue: { subscriptSizing: 'dynamic' } }],
  templateUrl: './pre-fight.html',
})
export class PreFight implements OnInit {
  private readonly logger = inject(LoggerService);
  private readonly encounterSelection = inject(EncounterSelectionService);
  private readonly mapFeature = inject(MapFeatureService);
  private readonly selectionStore = inject(SelectionStore);
  private readonly specMeta = inject(SpecMetaService);
  private readonly pendingTasks = inject(PendingTasks);

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
    return this.specMeta.classList().filter(cls => this.specMeta.specsForClass(cls.className, available).length > 0);
  });
  protected readonly specsForSelectedClass = computed(() =>
    this.specMeta.specsForClass(this.selectedClass(), this.specs().map(entry => entry.spec)));
  protected readonly selectedEncounter = computed(() =>
    this.encounters().find(entry => entry.id === this.selectedEncId()));
  protected readonly loading = signal(false);
  protected readonly loadingEncounters = signal(false);
  protected readonly error = signal<RenderableLoadError | null>(null);

  private encounterToken = 0;

  // Cards count as available until they report otherwise, which avoids a one-frame banner flash on a benched encounter (pre-fight cards render with no reveal gate).
  protected readonly cards = new CardDeck(PRE_FIGHT_CARDS, { availableUntilReported: true });
  protected readonly benchAvailable = this.cards.benchAvailable;
  protected readonly cardsBusy = this.cards.anyBusy;

  protected readonly mapReady = this.mapFeature.ready;

  protected onOpenMap(anchor: MapAnchor): void {
    this.mapFeature.openAt(anchor);
  }

  constructor() {
    // classes() fills only once the spec index and spec-meta have both landed, in either order.
    effect(() => {
      if (this.classes().length) this.classControl.enable({ emitEvent: false });
    });
  }

  ngOnInit(): void {
    void this._init();
  }

  private async _init(): Promise<void> {
    this.loading.set(true);
    try {
      const specs = await this.encounterSelection.getSpecs();
      if (specs.ok) {
        this.specs.set(specs.value);
      } else {
        this.surfaceLoadError(specs.error);
      }
    } finally {
      this.loading.set(false);
    }

    const autoSpec = this.selectionStore.loadPreFight()?.spec ?? '';
    const meta = await this.specMeta.resolve(autoSpec);
    if (autoSpec && meta && this.specs().some(specEntry => specEntry.spec === autoSpec)) {
      this.classControl.setValue(meta.className);
      this.specControl.enable({ emitEvent: false });
      this.specControl.setValue(autoSpec);
      void this._onSpecSelected(autoSpec);
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
    if (this.specMeta.specsForClass(this.classControl.value, available).length) {
      this.specControl.enable({ emitEvent: false });
    } else {
      this.specControl.disable({ emitEvent: false });
    }
  }

  protected onSpecChange(): void {
    const spec = this.specControl.value;
    this.selectionStore.savePreFight({ spec: spec || null });
    this.mapFeature.clear();
    // selectedEncId mirrors valueChanges; emit so the reset closes the encounter-gated cards.
    this.encControl.setValue(0, { emitEvent: true });
    this.encControl.disable({ emitEvent: false });
    this.encounters.set([]);
    if (!spec) return;
    void this._onSpecSelected(spec);
  }

  private async _onSpecSelected(spec: string): Promise<void> {
    this.error.set(null);
    this.loadingEncounters.set(true);
    const token = ++this.encounterToken;
    // Reported to PendingTasks: without it a stability wait resolves while this fire-and-forget load is still in flight.
    const done = this.pendingTasks.add();
    try {
      const encounters = await this.encounterSelection.getEncounters(spec);
      if (token !== this.encounterToken) return;
      if (!encounters.ok) {
        this.surfaceLoadError(encounters.error);
        this.encControl.disable({ emitEvent: false });
        return;
      }
      this.encounters.set(encounters.value);
      if (encounters.value.length) {
        this.encControl.enable({ emitEvent: false });
      } else {
        this.encControl.disable({ emitEvent: false });
      }
    } catch (cause) {
      this.logger.logWarn('encounterSelection.getEncounters', cause);
    } finally {
      if (token === this.encounterToken) this.loadingEncounters.set(false);
      done();
    }
  }

  private surfaceLoadError(error: LoadError): void {
    if (error.kind === 'permanent') this.logger.logWarn(error.id, error.context);
    this.error.set(error.kind === 'missing' ? null : error);
  }

  protected onEncChange(): void {
    const encId = this.encControl.value;
    const spec = this.specControl.value;
    this.mapFeature.clear();
    this.cards.markAllBusy();
    if (!encId || !spec) return;
    void this.mapFeature.loadBench(spec, encId);
  }
}
