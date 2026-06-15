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

type GearStatus = 'ok' | 'warn' | 'info' | 'unknown';

const SLOT_NAMES: Record<number, string> = {
  0:'Head', 1:'Neck', 2:'Shoulder', 3:'Back', 4:'Chest', 5:'Waist', 6:'Legs',
  7:'Feet', 8:'Wrists', 9:'Hands', 10:'Ring 1', 11:'Ring 2',
  12:'Trinket 1', 13:'Trinket 2', 14:'Back', 15:'Main Hand', 16:'Off Hand',
};

const STATUS_ICONS: Record<GearStatus, string> = {
  ok: 'check_circle', warn: 'warning', info: 'info', unknown: 'help_outline',
};

const STATUS_CLASSES: Record<GearStatus, string> = {
  ok: 'badge-success', warn: 'badge-warning', info: 'badge-info', unknown: 'text-[var(--muted)]',
};

interface CdPlanItem {
  name: string;
  spellId: number | null;
  firstCastS: number | null;
  uses: number | null;
  usesPerMin: number | null;
  bloodlust: boolean;
  bloodlustPct: number | null;
  holds: Array<{ castIndex: number; targetS: number }>;
  rule: string | null;
}

interface DefPlanItem {
  name: string;
  spellId: number | null;
  uses: number | null;
  firstCastS: number | null;
  windowsS: number[];
  rule: string | null;
}

interface EnchantRow {
  slotName: string;
  status: GearStatus;
  name: string;
  note: string | null;
}

interface TalentBuildRow {
  pct: number;
  isPlayer: boolean;
  link: string | null;
  playerName: string;
  label: string;
}

interface GemCheck {
  count: number;
  expected: number;
  status: GearStatus;
}

interface BurstWindowVm {
  startS: number;
  endS: number;
  cds: Array<{ name: string; spellId: number | null }>;
  aoe: boolean;
  dmg: number | null;
}

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

  // Cooldown game plan: target opener timing, expected uses, BL alignment and
  // hold targets per major cooldown, drawn from the top-parse benchmarks.
  protected readonly cdPlan = computed<CdPlanItem[]>(() => {
    const rb = this.rulebook();
    if (!rb?.major_cooldowns?.length) return [];
    const benchmarks = this.bench()?.per_cd_benchmarks ?? {};
    const cds = [...rb.major_cooldowns].sort((a, b) => {
      const pa = a.opener_priority ?? 99;
      const pb = b.opener_priority ?? 99;
      return pa !== pb ? pa - pb : a.name.localeCompare(b.name);
    });
    return cds.map(cd => {
      const b = benchmarks[cd.name];
      const holds = b?.majority_hold && b.hold_targets
        ? Object.entries(b.hold_targets)
            .sort((a, c) => Number(a[0]) - Number(c[0]))
            .map(([idx, h]) => ({ castIndex: Number(idx), targetS: h.target_s }))
        : [];
      return {
        name: cd.name,
        spellId: cd.spell_id ?? null,
        firstCastS: b?.avg_first_cast_s ?? null,
        uses: b?.avg_uses ?? null,
        usesPerMin: b?.uses_per_min?.avg ?? b?.avg_uses_per_min ?? null,
        bloodlust: !!cd.align_with_bloodlust,
        bloodlustPct: cd.align_with_bloodlust && b && b.bl_pct >= 40 ? b.bl_pct : null,
        holds,
        rule: cd.usage_rule ?? null,
      };
    });
  });

  // Defensive plan: when top parsers fire each defensive and how often.
  protected readonly defensivePlan = computed<DefPlanItem[]>(() => {
    const rb = this.rulebook();
    if (!rb?.defensives?.length) return [];
    const benchmarks = this.bench()?.per_defensive_benchmarks ?? {};
    const windows = this.bench()?.defensive_windows ?? [];
    return rb.defensives.map(def => {
      const b = benchmarks[def.name];
      const windowsS = windows
        .filter(w => (w.defensive_name ?? w.common_defensives?.[0]) === def.name)
        .map(w => w.time_s)
        .sort((a, c) => a - c);
      return {
        name: def.name,
        spellId: def.spell_id ?? null,
        uses: b?.avg_uses ?? null,
        firstCastS: b?.avg_first_cast_s ?? null,
        windowsS,
        rule: def.usage_rule ?? null,
      };
    }).filter(d => d.uses != null || d.firstCastS != null || d.windowsS.length || d.rule);
  });

  // Enchants: flag slots the player left un-enchanted that top parsers consider
  // mandatory, and surface where the player differs from the consensus enchant.
  protected readonly enchantRows = computed<EnchantRow[]>(() => {
    const gear = this.charGear();
    const stats = this.gearStats();
    const topEnch = stats?.enchants ?? {};
    const playerEnch = gear?.enchants ?? [];
    if (!Object.keys(topEnch).length && !playerEnch.length) return [];
    const slots = new Set<number>();
    for (const k of Object.keys(topEnch)) slots.add(Number(k));
    for (const e of playerEnch) slots.add(e.slot);

    const rows: EnchantRow[] = [];
    for (const slot of [...slots].sort((a, b) => a - b)) {
      const slotName = this.slotName(slot);
      const top = topEnch[slot]?.[0];
      const topName = top ? (top.name || `Enchant #${top.id}`) : '';
      const player = playerEnch.find(e => e.slot === slot);
      if (!player) {
        if (top && top.pct >= 70) {
          rows.push({ slotName, status: 'warn', name: 'Not enchanted',
            note: `${top.pct}% of top parsers enchant this slot` });
        } else if (top && top.pct >= 40) {
          rows.push({ slotName, status: 'info', name: 'Not enchanted',
            note: `${top.pct}% of top parsers enchant this slot` });
        }
        continue;
      }
      const playerName = player.name || `Enchant #${player.id}`;
      if (top && player.id === top.id) {
        rows.push({ slotName, status: 'ok', name: playerName, note: `Matches top parsers (${top.pct}%)` });
      } else if (top) {
        rows.push({ slotName, status: 'info', name: playerName, note: `Top parsers use ${topName} (${top.pct}%)` });
      } else {
        rows.push({ slotName, status: 'ok', name: playerName, note: null });
      }
    }
    return rows;
  });

  protected readonly enchantStatus = computed<GearStatus>(() =>
    this.enchantRows().some(r => r.status === 'warn') ? 'warn' : 'ok');

  // Top-parse talent builds with a link to an example parse running each one.
  protected readonly talentBuilds = computed<TalentBuildRow[]>(() => {
    const builds = this.gearStats()?.talent_builds ?? [];
    if (!builds.length) return [];
    const playerKey = this.charGear()?.talent_key ?? '';
    return builds.map((b, i) => ({
      pct: b.pct,
      isPlayer: !!playerKey && b.key === playerKey,
      link: b.report_code ? `https://www.warcraftlogs.com/reports/${b.report_code}#fight=${b.fight_id ?? 0}` : null,
      playerName: b.player_name || '',
      label: i === 0 ? 'Most common build' : `Alt build ${i}`,
    }));
  });

  // Filled-socket check: compare the player's gem count to the top-parse total.
  protected readonly gemCheck = computed<GemCheck | null>(() => {
    const gems = this.gearStats()?.gems;
    const count = this.charGear()?.gem_count;
    if (!gems || count == null) return null;
    const expected = gems.max_count;
    return { count, expected, status: count >= expected ? 'ok' : 'warn' };
  });

  // Map cooldown/defensive names (used as keys in burst windows) to spell ids.
  private readonly spellIdByName = computed<Record<string, number>>(() => {
    const rb = this.rulebook();
    const map: Record<string, number> = {};
    for (const cd of rb?.major_cooldowns ?? []) if (cd.spell_id) map[cd.name] = cd.spell_id;
    for (const d of rb?.defensives ?? []) if (d.spell_id) map[d.name] = d.spell_id;
    return map;
  });

  protected readonly burstWindows = computed<BurstWindowVm[]>(() => {
    const map = this.spellIdByName();
    return (this.bench()?.burst_windows ?? []).map(bw => ({
      startS: bw.time_s,
      endS: bw.time_s + bw.window_length_s,
      cds: (bw.common_cds ?? []).map(n => ({ name: n, spellId: map[n] ?? null })),
      aoe: (bw.avg_targets ?? 1) >= 2,
      dmg: bw.dmg_avg ?? null,
    }));
  });

  protected readonly showMap = computed(() => !!this.panel.positions());

  protected openMap(bw: BurstWindowVm): void {
    const label = bw.cds.map(c => c.name).join(', ') || 'Burst window';
    this.panel.openAt(bw.startS, { kind: 'boss' }, label);
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

  protected slotName(slot: number): string { return SLOT_NAMES[slot] || `Slot ${slot}`; }

  protected statusIcon(status: GearStatus): string { return STATUS_ICONS[status]; }
  protected statusClass(status: GearStatus): string { return STATUS_CLASSES[status]; }

  protected talentStatus(topStats: EncounterGearStats | null): { status: GearStatus; note: string } {
    const builds = topStats?.talent_builds ?? [];
    if (!builds.length) return { status: 'unknown', note: 'No talent data yet.' };
    const topPct = builds[0]?.pct ?? 0;
    const key = this.charGear()?.talent_key ?? '';
    // No comparable player build (not ranked here, or format mismatch): just
    // present the consensus build positively rather than flagging it.
    if (!key || key.split(':')[0] !== (builds[0]?.key ?? '').split(':')[0]) {
      return { status: 'ok', note: `Most common build used by ${topPct}% of top parsers` };
    }
    if (builds.some(b => b.key === key)) {
      return { status: 'ok', note: 'On a top-parse build' };
    }
    return { status: 'warn', note: `Your build differs - most common used by ${topPct}% of top parsers` };
  }

}
