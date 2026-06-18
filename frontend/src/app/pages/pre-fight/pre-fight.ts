import { ChangeDetectionStrategy, Component, OnInit, inject, signal, computed } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatChipsModule } from '@angular/material/chips';
import { MatDividerModule } from '@angular/material/divider';
import { MatIconModule } from '@angular/material/icon';
import { WclAuthService } from '../../core/services/wcl-auth';
import { WclApiService } from '../../core/services/wcl-api';
import { EncounterService } from '../../core/services/encounter';
import { PositioningPanelService } from '../../core/services/positioning-panel';
import { CharacterInfo, CharacterGear, WclUserCharacter } from '../../core/models/wcl.models';
import { EncounterEntry, EncounterBench, EncounterGearStats } from '../../core/models/encounter.models';
import { Rulebook } from '../../core/models/rulebook.models';
import { IconCacheService } from '../../core/services/icon-cache';
import { LoadingSpinnerComponent } from '../../shared/components/loading-spinner/loading-spinner';
import { CalloutComponent } from '../../shared/components/callout/callout';
import { GameIconComponent } from '../../shared/components/game-icon/game-icon';
import { FormatDurationPipe } from '../../shared/pipes/format-duration-pipe';
import { FormatDamagePipe } from '../../shared/pipes/format-damage-pipe';
import { FormatSpecPipe } from '../../shared/pipes/format-spec-pipe';
import {
  GearStatus, BurstWindowVm,
  slotName, statusIcon, statusClass,
  buildCdPlan, buildDefensivePlan, buildEnchantRows, enchantStatusOf,
  buildTalentBuilds, buildGemCheck, buildBurstWindows, talentStatusOf,
} from './pre-fight.vm';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-pre-fight',
  imports: [
    ReactiveFormsModule, MatFormFieldModule, MatInputModule, MatSelectModule,
    MatButtonModule, MatCardModule, MatChipsModule, MatDividerModule, MatIconModule,
    LoadingSpinnerComponent, CalloutComponent, GameIconComponent,
    DecimalPipe, FormatDurationPipe, FormatDamagePipe, FormatSpecPipe,
  ],
  templateUrl: './pre-fight.html',
})
export class PreFightComponent implements OnInit {
  private readonly auth = inject(WclAuthService);
  private readonly wclApi = inject(WclApiService);
  private readonly icons = inject(IconCacheService);
  private readonly encounterSvc = inject(EncounterService);
  private readonly panel = inject(PositioningPanelService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  protected readonly linkedCharControl = new FormControl<WclUserCharacter | null>(null);
  protected readonly manualSpecControl = new FormControl('', { nonNullable: true });
  protected readonly encControl = new FormControl<number>({ value: 0, disabled: true }, { nonNullable: true });

  protected readonly linkedChars = signal<WclUserCharacter[]>([]);
  protected readonly charInfo = signal<CharacterInfo | null>(null);
  protected readonly charGear = signal<CharacterGear | null>(null);
  protected readonly encounters = signal<EncounterEntry[]>([]);
  protected readonly selectedEncId = toSignal(this.encControl.valueChanges, { initialValue: this.encControl.value });
  protected readonly bench = signal<EncounterBench | null>(null);
  protected readonly rulebook = signal<Rulebook | null>(null);
  protected readonly loading = signal(false);
  protected readonly loadingBrief = signal(false);
  protected readonly error = signal('');
  protected readonly gearStats = computed(() => this.bench()?.gear ?? null);

  protected readonly cdPlan = computed(() => buildCdPlan(this.rulebook(), this.bench()));
  protected readonly defensivePlan = computed(() => buildDefensivePlan(this.rulebook(), this.bench()));
  protected readonly enchantRows = computed(() => buildEnchantRows(this.charGear(), this.gearStats()));
  protected readonly enchantStatus = computed<GearStatus>(() => enchantStatusOf(this.enchantRows()));
  protected readonly talentBuilds = computed(() => buildTalentBuilds(this.gearStats(), this.charGear()?.talent_key ?? ''));
  protected readonly gemCheck = computed(() => buildGemCheck(this.gearStats(), this.charGear()?.gem_count));
  protected readonly burstWindows = computed(() => buildBurstWindows(this.rulebook(), this.bench()));

  protected readonly showMap = computed(() => !!this.panel.positions());

  protected openMap(bw: BurstWindowVm): void {
    const label = bw.cds.map(c => c.name).join(', ') || 'Burst window';
    const spellIds = bw.cds.map(c => c.spellId).filter((id): id is number => id != null);
    this.panel.openAt(bw.startS, { kind: 'boss' }, label, spellIds);
  }

  async ngOnInit(): Promise<void> {
    if (!this.auth.isLoggedIn()) return;
    await this._init();
    const autoEnc = parseInt(this.route.snapshot.queryParamMap.get('encounter') || '0', 10);
    if (autoEnc && this.charInfo()?.spec) {
      this.encControl.setValue(autoEnc);
      await this.onEncChange();
    }
  }

  private async _init(): Promise<void> {
    let chars: WclUserCharacter[] = [];
    try {
      chars = await this.wclApi.fetchUserCharacters();
    } catch (err) {
      this.error.set(`Could not load your WCL characters: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.linkedChars.set(chars);
    if (chars.length) {
      this.linkedCharControl.setValue(chars[0]);
      await this._loadLinkedChar(chars[0]);
    }
  }

  protected async onLinkedCharChange(char: WclUserCharacter): Promise<void> {
    await this._loadLinkedChar(char);
  }

  private async _loadLinkedChar(char: WclUserCharacter): Promise<void> {
    this.error.set('');
    this.loading.set(true);
    this.charInfo.set(null);
    this.encounters.set([]);
    try {
      const info = await this.wclApi.charLookup(char.name, char.serverSlug, char.serverRegion);
      this.charInfo.set(info);
      if (info.spec) {
        await this._loadEncountersForSpec(info.spec);
      } else {
        this.error.set('Could not auto-detect spec. Enter it manually below.');
      }
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Failed to load character.');
    } finally {
      this.loading.set(false);
    }
  }

  protected async applyManualSpec(): Promise<void> {
    const spec = this.manualSpecControl.value.trim();
    if (!spec) return;
    const info = this.charInfo();
    if (!info) return;
    this.charInfo.set({ ...info, spec });
    this.error.set('');
    await this._loadEncountersForSpec(spec);
  }

  private async _loadEncountersForSpec(spec: string): Promise<void> {
    const enc = await this.encounterSvc.getEncounters(spec);
    this.encounters.set(enc);
    if (enc.length) {
      this.encControl.enable({ emitEvent: false });
    } else {
      this.encControl.disable({ emitEvent: false });
      this.error.set(`No parse data ingested yet for ${spec}. Run "npm run ingest" to populate encounter data.`);
    }
  }

  protected async onEncChange(): Promise<void> {
    this.router.navigate([], { queryParams: { encounter: this.selectedEncId() || null }, replaceUrl: true });
    this.bench.set(null);
    this.charGear.set(null);
    this.rulebook.set(null);
    this.panel.clear();
    if (!this.selectedEncId()) return;
    const info = this.charInfo();
    if (!info?.spec) return;

    this.loadingBrief.set(true);
    try {
      const [gearData, benchData, rulebookData, positions] = await Promise.all([
        info.name ? this.wclApi.getCharGear(info.name, info.server, info.region, this.selectedEncId()) : Promise.resolve({ found: false }),
        this.encounterSvc.getBench(info.spec, this.selectedEncId()),
        this.encounterSvc.getRulebook(info.spec),
        this.encounterSvc.getPositions(info.spec, this.selectedEncId()),
      ]);
      if ((gearData as CharacterGear).found) this.charGear.set(gearData as CharacterGear);
      this.bench.set(benchData);
      this.rulebook.set(rulebookData);
      // Pre-fight has no live pull, so the map shows the top-parse benchmark only.
      this.panel.setContext(positions, null);
      await this._seedSpellIcons();
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Failed to load encounter data.');
    } finally {
      this.loadingBrief.set(false);
    }
  }

  // Spell icon art only comes from a report's masterData, so seed the cache from
  // the character's most recent report to give the plan/burst cards spell icons.
  private async _seedSpellIcons(): Promise<void> {
    const report = this.charGear()?.source_report || this.charInfo()?.source_report;
    if (!report) return;
    try {
      this.icons.seed(await this.wclApi.getReportAbilities(report));
    } catch { /* icons are best-effort; names still render without art */ }
  }

  protected readonly slotName = slotName;
  protected readonly statusIcon = statusIcon;
  protected readonly statusClass = statusClass;

  protected talentStatus(topStats: EncounterGearStats | null): { status: GearStatus; note: string } {
    return talentStatusOf(topStats, this.charGear()?.talent_key ?? '');
  }

}
