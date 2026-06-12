import { ChangeDetectionStrategy, Component, OnInit, inject, signal, computed } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { WclAuthService } from '../../core/services/wcl-auth';
import { WclApiService } from '../../core/services/wcl-api';
import { EncounterService } from '../../core/services/encounter';
import { CharacterInfo, CharacterGear, WclUserCharacter } from '../../core/models/wcl.models';
import { EncounterEntry, EncounterBench, EncounterGearStats } from '../../core/models/encounter.models';
import { AuthBannerComponent } from '../../shared/components/auth-banner/auth-banner';
import { LoadingSpinnerComponent } from '../../shared/components/loading-spinner/loading-spinner';
import { FormatDurationPipe } from '../../shared/pipes/format-duration-pipe';
import { FormatSpecPipe } from '../../shared/pipes/format-spec-pipe';


const SLOT_NAMES: Record<number, string> = {
  0:'Head', 1:'Neck', 2:'Shoulder', 3:'Back', 4:'Chest', 5:'Waist', 6:'Legs',
  7:'Feet', 8:'Wrists', 9:'Hands', 10:'Ring 1', 11:'Ring 2',
  12:'Trinket 1', 13:'Trinket 2', 14:'Back', 15:'Main Hand', 16:'Off Hand',
};

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-pre-fight',
  imports: [
    ReactiveFormsModule, MatFormFieldModule, MatInputModule, MatSelectModule,
    MatButtonModule, MatCardModule, MatIconModule,
    AuthBannerComponent, LoadingSpinnerComponent, FormatDurationPipe, FormatSpecPipe,
  ],
  templateUrl: './pre-fight.html',
  styleUrl: './pre-fight.scss',
})
export class PreFightComponent implements OnInit {
  private readonly auth = inject(WclAuthService);
  private readonly wclApi = inject(WclApiService);
  private readonly encounterSvc = inject(EncounterService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  protected readonly isLoggedIn = this.auth.isLoggedIn;

  protected readonly linkedCharControl = new FormControl<WclUserCharacter | null>(null);
  protected readonly manualSpecControl = new FormControl('', { nonNullable: true });
  protected readonly encControl = new FormControl<number>({ value: 0, disabled: true }, { nonNullable: true });

  protected readonly linkedChars = signal<WclUserCharacter[]>([]);
  protected readonly charInfo = signal<CharacterInfo | null>(null);
  protected readonly charGear = signal<CharacterGear | null>(null);
  protected readonly encounters = signal<EncounterEntry[]>([]);
  protected readonly selectedEncId = toSignal(this.encControl.valueChanges, { initialValue: this.encControl.value });
  protected readonly bench = signal<EncounterBench | null>(null);
  protected readonly rulebook = signal<{ major_cooldowns?: unknown[] } | null>(null);
  protected readonly loading = signal(false);
  protected readonly loadingBrief = signal(false);
  protected readonly error = signal('');
  protected readonly gearStats = computed(() => this.bench()?.gear ?? null);

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
    if (!this.selectedEncId()) return;
    const info = this.charInfo();
    if (!info?.spec) return;

    this.loadingBrief.set(true);
    try {
      const [gearData, benchData, rulebookData] = await Promise.all([
        info.name ? this.wclApi.getCharGear(info.name, info.server, info.region, this.selectedEncId()) : Promise.resolve({ found: false }),
        this.encounterSvc.getBench(info.spec, this.selectedEncId()),
        this.encounterSvc.getRulebook(info.spec),
      ]);
      if ((gearData as CharacterGear).found) this.charGear.set(gearData as CharacterGear);
      this.bench.set(benchData);
      this.rulebook.set(rulebookData as { major_cooldowns?: unknown[] });
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Failed to load encounter data.');
    } finally {
      this.loadingBrief.set(false);
    }
  }

  protected slotName(slot: number): string { return SLOT_NAMES[slot] || `Slot ${slot}`; }

  protected talentStatus(topStats: EncounterGearStats | null): { status: string; note: string } {
    if (!topStats?.talent_builds?.length) return { status: 'unknown', note: 'No talent data yet.' };
    const gear = this.charGear();
    if (!gear?.talent_key) return { status: 'unknown', note: 'Talent data unavailable from WCL.' };
    const pv = gear.talent_key.split(':')[0];
    const tv = (topStats.talent_builds[0]?.key || '').split(':')[0];
    if (pv !== tv) return { status: 'unknown', note: 'Talent comparison unavailable (format mismatch).' };
    const match = topStats.talent_builds.find(b => b.key === gear.talent_key);
    if (match && match.pct >= 40) return { status: 'ok', note: `Matches top parse build (${match.pct}% of parses)` };
    const top = topStats.talent_builds[0];
    return { status: 'warn', note: `Build differs — most common used by ${top?.pct ?? 0}% of top parsers` };
  }

}
