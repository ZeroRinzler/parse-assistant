import {
  ChangeDetectionStrategy, Component, OnInit,
  inject, signal, computed,
} from '@angular/core';
import { toObservable, toSignal, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { EMPTY, combineLatest, from, merge, of } from 'rxjs';
import { distinctUntilChanged, exhaustMap, map, switchMap, tap } from 'rxjs/operators';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { WclAuthService } from '../../core/services/wcl-auth';
import { WclApiService } from '../../core/services/wcl-api';
import { AnalysisService } from '../../core/services/analysis';
import { EncounterService } from '../../core/services/encounter';
import { IconCacheService } from '../../core/services/icon-cache';
import { PositioningPanelService } from '../../core/services/positioning-panel';
import { MapContextService } from '../../core/services/map-context';
import { LiveReportSyncService, POLL_INTERVAL_MS } from '../../core/services/live-report-sync';
import { WclFight, WclPlayer, WclUserCharacter } from '../../core/models/wcl.models';
import { EncounterGearStats } from '../../core/models/encounter.models';
import { AnalysisResult } from '../../core/models/analysis.models';
import { LoadingSpinnerComponent } from '../../shared/components/loading-spinner/loading-spinner';
import { AnalysisResultComponent } from './analysis-result/analysis-result';
import { FormatDurationPipe } from '../../shared/pipes/format-duration-pipe';
import { FormatSpecPipe } from '../../shared/pipes/format-spec-pipe';
import { logWarn } from '../../core/log';
import { extractCode, buildFights, buildPlayers, visiblePlayersOf, pickPlayerId, pickLivePlayerId } from './post-raid.vm';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-post-raid',
  imports: [
    ReactiveFormsModule, MatFormFieldModule, MatInputModule, MatSelectModule,
    MatButtonModule, MatCardModule, MatSlideToggleModule,
    LoadingSpinnerComponent, AnalysisResultComponent,
    FormatDurationPipe, FormatSpecPipe,
  ],
  templateUrl: './post-raid.html',
})
export class PostRaidComponent implements OnInit {
  private readonly auth = inject(WclAuthService);
  private readonly wclApi = inject(WclApiService);
  private readonly analysisSvc = inject(AnalysisService);
  private readonly encounterSvc = inject(EncounterService);
  private readonly icons = inject(IconCacheService);
  private readonly panel = inject(PositioningPanelService);
  private readonly mapCtx = inject(MapContextService);
  private readonly liveSync = inject(LiveReportSyncService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  protected readonly reportControl = new FormControl('', { nonNullable: true });
  protected readonly fightControl = new FormControl<number | null>(null);
  protected readonly playerControl = new FormControl<number | null>(null);
  protected readonly liveControl = new FormControl(false, { nonNullable: true });

  protected readonly loadingReport = signal(false);
  protected readonly loadingAnalysis = signal(false);
  protected readonly loadingMsg = signal('Loading…');
  protected readonly error = signal('');
  protected readonly status = signal('');

  protected readonly fights = signal<WclFight[]>([]);
  protected readonly players = signal<WclPlayer[]>([]);
  protected readonly selectedFightId = toSignal(this.fightControl.valueChanges, { initialValue: this.fightControl.value });
  protected readonly selectedPlayerId = toSignal(this.playerControl.valueChanges, { initialValue: this.playerControl.value });
  protected readonly liveSyncEnabled = toSignal(this.liveControl.valueChanges, { initialValue: this.liveControl.value });
  protected readonly result = signal<AnalysisResult | null>(null);
  protected readonly topGear = signal<EncounterGearStats | null>(null);

  /** Current report code, driven by loadReport(). Used by the polling pipeline. */
  protected readonly reportCode = signal('');

  private _masterAbilities: { gameID: number; name: string; icon: string }[] = [];
  private _enemies: { id: number; name: string; gameID: number }[] = [];
  private _userChars: WclUserCharacter[] = [];
  /** Incremented on each analyzePlayer() call to cancel stale gear fetches. */
  private _gearFetchNonce = 0;

  protected readonly visiblePlayers = computed(() =>
    visiblePlayersOf(this.fights(), this.players(), this.selectedFightId()));

  // Declarative polling pipeline. Must live in a field initializer so that
  // toObservable() and takeUntilDestroyed() run inside the injection context.
  // switchMap tears down the previous poll stream whenever live/reportCode changes.
  // exhaustMap drops concurrent poll attempts while one is in flight.
  private readonly _pollingSub = combineLatest([
    toObservable(this.liveSyncEnabled),
    toObservable(this.reportCode),
  ]).pipe(
    tap(([live, code]) => {
      if (live && !code) this.status.set('Load a report to start live sync.');
      else if (!live) this.status.set('');
    }),
    map(([live, code]) => live && !!code),
    distinctUntilChanged(),
    switchMap(active =>
      active
        ? merge(of(undefined as void), this.liveSync.pollTriggers())
        : EMPTY,
    ),
    exhaustMap(() => from(this._pollOnce())),
    takeUntilDestroyed(),
  ).subscribe();

  ngOnInit(): void {
    const params = this.route.snapshot.queryParamMap;
    if (params.get('live') === '1') this.liveControl.setValue(true);
    const reportParam = params.get('report');
    if (reportParam) {
      this.reportControl.setValue(reportParam);
      void this.loadReport(
        params.get('fight')  ? parseInt(params.get('fight')!,  10) : null,
        params.get('player') ? parseInt(params.get('player')!, 10) : null,
      );
    }
  }

  protected async onReportChange(): Promise<void> {
    await this.loadReport();
  }

  protected async loadReport(autoFight: number | null = null, autoPlayer: number | null = null): Promise<void> {
    this.error.set('');
    const url = this.reportControl.value.trim();
    if (!url) return;
    // Setting reportCode to '' stops any active poll before the fetch completes.
    this.reportCode.set('');

    this.loadingReport.set(true);
    this.fights.set([]);
    this.players.set([]);
    this.result.set(null);
    this.panel.clear();

    try {
      if (!this.auth.isLoggedIn()) {
        throw new Error('Sign in with WCL to load reports.');
      }
      this.loadingMsg.set('Fetching report from WCL…');
      const [report, userChars] = await Promise.all([
        this.wclApi.getReport(extractCode(url)),
        this.wclApi.getUserCharacters().catch(err => {
          logWarn('loadReport: fetch user characters', err);
          return [] as WclUserCharacter[];
        }),
      ]);
      this._userChars = userChars;
      this.fights.set(buildFights(report.fights));
      this.players.set(buildPlayers(report.masterData?.actors));
      this._masterAbilities = report.masterData?.abilities ?? [];
      this._enemies = report.masterData?.enemies ?? [];
      if (report.masterData?.abilities) this.icons.seed(report.masterData.abilities);

      const lastFight = this.fights()[this.fights().length - 1];
      this.fightControl.setValue(autoFight ?? lastFight?.id ?? null);
      this._applyAutoPlayer(autoPlayer);
      // Set reportCode last - this activates the polling pipeline if liveSync is on.
      this.reportCode.set(extractCode(url));
      this._syncUrl();
      await this.analyzePlayer();
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Failed to load report.');
    } finally {
      this.loadingReport.set(false);
    }
  }

  protected onLiveToggle(): void {
    // liveControl change propagates to liveSyncEnabled signal, which the
    // polling pipeline reacts to automatically via combineLatest.
    this._syncUrl();
  }

  private async _pollOnce(): Promise<void> {
    this.error.set('');
    this.status.set('Checking for new pulls…');
    try {
      const report = await this.wclApi.getReport(this.reportCode());
      this.fights.set(buildFights(report.fights));
      this.players.set(buildPlayers(report.masterData?.actors));
      this._masterAbilities = report.masterData?.abilities ?? [];
      this._enemies = report.masterData?.enemies ?? [];
      if (report.masterData?.abilities) this.icons.seed(report.masterData.abilities);

      const latest = this.fights()[this.fights().length - 1];
      if (!latest) { this.status.set('No boss pulls found.'); return; }

      // Cheap-diff: latest pull unchanged and already analyzed - skip re-analysis.
      if (this.selectedFightId() === latest.id && this.result()) {
        this.status.set(`Last updated ${new Date().toLocaleTimeString()} · Polling every ${POLL_INTERVAL_MS / 1000}s`);
        return;
      }

      const currentName = this.players().find(player => player.id === this.selectedPlayerId())?.name ?? null;
      const visible = visiblePlayersOf(this.fights(), this.players(), latest.id);
      // emitEvent:true keeps selectedFightId/selectedPlayerId signals in sync;
      // change handlers guard themselves with liveSyncEnabled() and won't fire from (selectionChange)
      // since that only triggers from user interaction, not programmatic setValue.
      this.fightControl.setValue(latest.id);
      this.playerControl.setValue(pickLivePlayerId(visible, currentName, this._userChars));
      this._syncUrl();
      await this.analyzePlayer();
      this.status.set(`Updated ${new Date().toLocaleTimeString()} · ${latest.name}`);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Poll failed.');
    }
  }

  protected async onFightChange(): Promise<void> {
    if (this.liveSyncEnabled()) return;
    this._applyAutoPlayer(null);
    this._syncUrl();
    await this.analyzePlayer();
  }

  protected async onPlayerChange(): Promise<void> {
    if (this.liveSyncEnabled()) return;
    this._syncUrl();
    await this.analyzePlayer();
  }

  protected async analyzePlayer(): Promise<void> {
    this.error.set('');
    const fightId = this.selectedFightId();
    const playerId = this.selectedPlayerId();
    if (!fightId || !playerId) return;

    const nonce = ++this._gearFetchNonce;
    this.loadingAnalysis.set(true);
    this.result.set(null);
    this.topGear.set(null);
    this.panel.clear();
    this.loadingMsg.set('Fetching events…');
    try {
      const data = await this.analysisSvc.analyze(this.reportCode(), fightId, playerId, this.fights(), this._masterAbilities);
      this.result.set(data);
      const fight = this.fights().find(f => f.id === fightId);
      if (fight) void this.mapCtx.prepare(this.reportCode(), fight, playerId, data.spec, this._enemies);

      if (fight?.encounterID) {
        // Bench gear is static JSON already fetched by the analysis pipeline,
        // so this getBench call hits the browser cache.
        this.encounterSvc.getBench(data.spec, fight.encounterID).then(bench => {
          if (nonce === this._gearFetchNonce && bench) this.topGear.set(bench.gear);
        });

        // Fetch player gear in background; matches the logged-in account's characters.
        const player = this.players().find(p => p.id === playerId);
        const userChar = this._userChars.find(character =>
          character.name.toLowerCase() === (player?.name ?? '').toLowerCase() &&
          character.serverSlug.toLowerCase() === (player?.server ?? '').toLowerCase(),
        );
        if (userChar) {
          this.wclApi.getCharGear(userChar.name, userChar.serverSlug, userChar.serverRegion, fight.encounterID)
            .then(gearData => {
              if (nonce === this._gearFetchNonce && gearData.found) {
                this.result.update(r => r ? { ...r, player_gear: gearData } : r);
              }
            })
            .catch(err => logWarn('analyzePlayer: fetch player gear', err));
        }
      }
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Analysis failed.');
    } finally {
      this.loadingAnalysis.set(false);
    }
  }

  private _applyAutoPlayer(autoPlayer: number | null): void {
    this.playerControl.setValue(pickPlayerId(this.visiblePlayers(), this._userChars, autoPlayer));
  }

  private _syncUrl(): void {
    const queryParams: Record<string, string> = {};
    if (this.reportCode()) queryParams['report'] = this.reportCode();
    if (this.selectedFightId()) queryParams['fight'] = String(this.selectedFightId());
    if (this.selectedPlayerId()) queryParams['player'] = String(this.selectedPlayerId());
    if (this.liveSyncEnabled()) queryParams['live'] = '1';
    this.router.navigate([], { queryParams, replaceUrl: true });
  }
}
