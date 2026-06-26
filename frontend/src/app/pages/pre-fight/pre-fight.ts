import { ChangeDetectionStrategy, Component, OnInit, inject, signal, computed } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatChipsModule } from '@angular/material/chips';
import { MatDividerModule } from '@angular/material/divider';
import { MatIconModule } from '@angular/material/icon';
import { GearSectionComponent } from '../post-raid/gear-section/gear-section';
import { EncounterService } from '../../core/services/encounter';
import { PositioningPanelService } from '../../core/services/positioning-panel';
import { SpecEntry, EncounterEntry, EncounterBench } from '../../core/models/encounter.models';
import { Rulebook } from '../../core/models/rulebook.models';
import { LoadingSpinnerComponent } from '../../shared/components/loading-spinner/loading-spinner';
import { CalloutComponent } from '../../shared/components/callout/callout';
import { GameIconComponent } from '../../shared/components/game-icon/game-icon';
import { FormatDurationPipe } from '../../shared/pipes/format-duration-pipe';
import { FormatDamagePipe } from '../../shared/pipes/format-damage-pipe';
import { FormatSpecPipe } from '../../shared/pipes/format-spec-pipe';
import {
  BurstWindowVm,
  buildCdPlan, buildDefensivePlan, buildBurstWindows,
} from './pre-fight.vm';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-pre-fight',
  imports: [
    ReactiveFormsModule, MatFormFieldModule, MatSelectModule,
    MatButtonModule, MatCardModule, MatChipsModule, MatDividerModule, MatIconModule,
    LoadingSpinnerComponent, CalloutComponent, GameIconComponent, GearSectionComponent,
    DecimalPipe, FormatDurationPipe, FormatDamagePipe, FormatSpecPipe,
  ],
  templateUrl: './pre-fight.html',
})
export class PreFightComponent implements OnInit {
  private readonly encounterSvc = inject(EncounterService);
  private readonly panel = inject(PositioningPanelService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  protected readonly specControl = new FormControl('', { nonNullable: true });
  protected readonly encControl = new FormControl<number>({ value: 0, disabled: true }, { nonNullable: true });

  protected readonly specs = signal<SpecEntry[]>([]);
  protected readonly encounters = signal<EncounterEntry[]>([]);
  protected readonly selectedSpec = toSignal(this.specControl.valueChanges, { initialValue: this.specControl.value });
  protected readonly selectedEncId = toSignal(this.encControl.valueChanges, { initialValue: this.encControl.value });
  protected readonly bench = signal<EncounterBench | null>(null);
  protected readonly rulebook = signal<Rulebook | null>(null);
  protected readonly loading = signal(false);
  protected readonly loadingBrief = signal(false);
  protected readonly error = signal('');
  protected readonly gearStats = computed(() => this.bench()?.gear ?? null);

  protected readonly cdPlan = computed(() => buildCdPlan(this.rulebook(), this.bench()));
  protected readonly defensivePlan = computed(() => buildDefensivePlan(this.rulebook(), this.bench()));
  protected readonly burstWindows = computed<BurstWindowVm[]>(() => buildBurstWindows(this.rulebook(), this.bench()));

  protected readonly showMap = computed(() => !!this.panel.positions());

  protected openMap(bw: BurstWindowVm): void {
    const label = bw.cds.map(c => c.name).join(', ') || 'Burst window';
    const spellIds = bw.cds.map(c => c.spellId).filter((id): id is number => id != null);
    this.panel.openAt(bw.startS, { kind: 'boss' }, label, spellIds);
  }

  async ngOnInit(): Promise<void> {
    this.loading.set(true);
    try {
      const specs = await this.encounterSvc.getSpecs();
      this.specs.set(specs);
      if (specs.length) this.specControl.enable({ emitEvent: false });
    } finally {
      this.loading.set(false);
    }

    const params = this.route.snapshot.queryParamMap;
    const autoSpec = params.get('spec') || '';
    const autoEnc = parseInt(params.get('encounter') || '0', 10);

    if (autoSpec && this.specs().some(s => s.spec === autoSpec)) {
      this.specControl.setValue(autoSpec);
      await this._onSpecSelected(autoSpec);
      if (autoEnc) {
        this.encControl.setValue(autoEnc);
        await this.onEncChange();
      }
    }
  }

  protected async onSpecChange(): Promise<void> {
    const spec = this.specControl.value;
    this.router.navigate([], { queryParams: { spec: spec || null, encounter: null }, replaceUrl: true });
    this.bench.set(null);
    this.rulebook.set(null);
    this.panel.clear();
    this.encControl.setValue(0, { emitEvent: false });
    this.encControl.disable({ emitEvent: false });
    this.encounters.set([]);
    if (!spec) return;
    await this._onSpecSelected(spec);
  }

  private async _onSpecSelected(spec: string): Promise<void> {
    const enc = await this.encounterSvc.getEncounters(spec);
    this.encounters.set(enc);
    if (enc.length) {
      this.encControl.enable({ emitEvent: false });
    } else {
      this.encControl.disable({ emitEvent: false });
    }
  }

  protected async onEncChange(): Promise<void> {
    const encId = this.encControl.value;
    const spec = this.specControl.value;
    this.router.navigate([], { queryParams: { spec: spec || null, encounter: encId || null }, replaceUrl: true });
    this.bench.set(null);
    this.rulebook.set(null);
    this.panel.clear();
    if (!encId || !spec) return;

    this.loadingBrief.set(true);
    try {
      const [benchData, rulebookData, positions] = await Promise.all([
        this.encounterSvc.getBench(spec, encId),
        this.encounterSvc.getRulebook(spec),
        this.encounterSvc.getPositions(spec, encId),
      ]);
      this.bench.set(benchData);
      this.rulebook.set(rulebookData);
      this.panel.setContext(positions, null);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Failed to load encounter data.');
    } finally {
      this.loadingBrief.set(false);
    }
  }
}
