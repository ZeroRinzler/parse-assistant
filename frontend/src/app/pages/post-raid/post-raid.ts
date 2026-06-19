import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, inject, signal, computed } from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { toSignal, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { Subscription, from, fromEvent, interval, merge, of } from 'rxjs';
import { exhaustMap, filter } from 'rxjs/operators';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { WclAuthService } from '../../core/services/wcl-auth';
import { WclApiService } from '../../core/services/wcl-api';
import { AnalysisService } from '../../core/services/analysis';
import { IconCacheService } from '../../core/services/icon-cache';
import { PositioningPanelService } from '../../core/services/positioning-panel';
import { MapContextService } from '../../core/services/map-context';
import { WclFight, WclPlayer, WclUserCharacter } from '../../core/models/wcl.models';
import { AnalysisResult } from '../../core/models/analysis.models';
import { LoadingSpinnerComponent } from '../../shared/components/loading-spinner/loading-spinner';
import { AnalysisResultComponent } from './analysis-result/analysis-result';
import { FormatDurationPipe } from '../../shared/pipes/format-duration-pipe';
import { FormatSpecPipe } from '../../shared/pipes/format-spec-pipe';
import { extractCode, buildFights, buildPlayers, visiblePlayersOf, pickPlayerId, pickLivePlayerId } from './post-raid.vm';

const POLL_MS = 12_000;

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
  private readonly icons = inject(IconCacheService);
  private readonly panel = inject(PositioningPanelService);
  private readonly mapCtx = inject(MapContextService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly document = inject(DOCUMENT);
  private readonly destroyRef = inject(DestroyRef);

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
  protected readonly liveSync = toSignal(this.liveControl.valueChanges, { initialValue: this.liveControl.value });
  protected readonly result = signal<AnalysisResult | null>(null);

  private _reportCode = '';
  private _masterAbilities: { gameID: number; name: string; icon: string }[] = [];
  private _enemies: { id: number; name: string; gameID: number }[] = [];
  private _userChars: WclUserCharacter[] = [];
  private _pollSub: Subscription | null = null;

  protected readonly visiblePlayers = computed(() =>
    visiblePlayersOf(this.fights(), this.players(), this.selectedFightId()));

  async ngOnInit(): Promise<void> {
    const params = this.route.snapshot.queryParamMap;
    if (params.get('live') === '1') this.liveControl.setValue(true);
    const r = params.get('report');
    if (r) {
      this.reportControl.setValue(r);
      await this.loadReport(
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
    this._reportCode = extractCode(url);

    this._stopPolling();
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
        this.wclApi.getReport(this._reportCode),
        this.wclApi.fetchUserCharacters().catch(() => [] as WclUserCharacter[]),
      ]);
      this._userChars = userChars;
      this.fights.set(buildFights(report.fights));
      this.players.set(buildPlayers(report.masterData?.actors));
      this._masterAbilities = report.masterData?.abilities || [];
      this._enemies = report.masterData?.enemies || [];
      if (report.masterData?.abilities) this.icons.seed(report.masterData.abilities);

      const lastFight = this.fights()[this.fights().length - 1];
      this.fightControl.setValue(autoFight ?? lastFight?.id ?? null);
      this._applyAutoPlayer(autoPlayer);
      this._syncUrl();
      await this.analyzePlayer();
      if (this.liveSync()) this._startPolling();
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Failed to load report.');
    } finally {
      this.loadingReport.set(false);
    }
  }

  protected onLiveToggle(): void {
    if (this.liveSync()) {
      this._startPolling();
    } else {
      this._stopPolling();
    }
    this._syncUrl();
  }

  private _startPolling(): void {
    this._pollSub?.unsubscribe();
    if (!this._reportCode) {
      this.status.set('Load a report to start live sync.');
      return;
    }
    const isVisible = () => this.document.visibilityState === 'visible';
    let lastPollAt = 0;

    // Regular tick: fires every POLL_MS but is filtered out while hidden,
    // so no network requests happen when the tab is not visible.
    const tick$ = interval(POLL_MS).pipe(filter(isVisible));

    // Refocus: when the tab becomes visible, poll immediately if POLL_MS has
    // elapsed since the last poll (12s cooldown prevents accidental spam).
    const refocus$ = fromEvent(this.document, 'visibilitychange').pipe(
      filter(() => isVisible() && Date.now() - lastPollAt >= POLL_MS),
    );

    this._pollSub = merge(of(0), tick$, refocus$).pipe(
      exhaustMap(() => { lastPollAt = Date.now(); return from(this._pollOnce()); }),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe();
  }

  private _stopPolling(): void {
    this._pollSub?.unsubscribe();
    this._pollSub = null;
    this.status.set('');
  }

  private async _pollOnce(): Promise<void> {
    this.error.set('');
    this.status.set('Checking for new pulls…');
    try {
      const report = await this.wclApi.getReport(this._reportCode);
      this.fights.set(buildFights(report.fights));
      this.players.set(buildPlayers(report.masterData?.actors));
      this._masterAbilities = report.masterData?.abilities || [];
      this._enemies = report.masterData?.enemies || [];
      if (report.masterData?.abilities) this.icons.seed(report.masterData.abilities);

      const latest = this.fights()[this.fights().length - 1];
      if (!latest) { this.status.set('No boss pulls found.'); return; }

      // Cheap-diff: latest pull unchanged and already analyzed - skip re-analysis.
      if (this.selectedFightId() === latest.id && this.result()) {
        this.status.set(`Last updated ${new Date().toLocaleTimeString()} · Polling every ${POLL_MS / 1000}s`);
        return;
      }

      const currentName = this.players().find(p => p.id === this.selectedPlayerId())?.name ?? null;
      const visible = visiblePlayersOf(this.fights(), this.players(), latest.id);
      // emitEvent:true keeps selectedFightId/selectedPlayerId signals in sync;
      // change handlers guard themselves with liveSync() and won't fire from (selectionChange)
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
    if (this.liveSync()) return;
    this._applyAutoPlayer(null);
    this._syncUrl();
    await this.analyzePlayer();
  }

  protected async onPlayerChange(): Promise<void> {
    if (this.liveSync()) return;
    this._syncUrl();
    await this.analyzePlayer();
  }

  protected async analyzePlayer(): Promise<void> {
    this.error.set('');
    const fightId = this.selectedFightId();
    const playerId = this.selectedPlayerId();
    if (!fightId || !playerId) return;

    this.loadingAnalysis.set(true);
    this.result.set(null);
    this.panel.clear();
    this.loadingMsg.set('Fetching events…');
    try {
      const data = await this.analysisSvc.analyze(this._reportCode, fightId, playerId, this.fights(), this._masterAbilities);
      this.result.set(data);
      const fight = this.fights().find(f => f.id === fightId);
      if (fight) void this.mapCtx.prepare(this._reportCode, fight, playerId, data.spec, this._enemies);
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
    const p: Record<string, string> = {};
    if (this._reportCode) p['report'] = this._reportCode;
    if (this.selectedFightId()) p['fight'] = String(this.selectedFightId());
    if (this.selectedPlayerId()) p['player'] = String(this.selectedPlayerId());
    if (this.liveSync()) p['live'] = '1';
    this.router.navigate([], { queryParams: p, replaceUrl: true });
  }
}
