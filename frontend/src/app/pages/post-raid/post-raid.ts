import { ChangeDetectionStrategy, Component, OnInit, inject, signal, computed } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { WclAuthService } from '../../core/services/wcl-auth';
import { WclApiService } from '../../core/services/wcl-api';
import { AnalysisService } from '../../core/services/analysis';
import { IconCacheService } from '../../core/services/icon-cache';
import { WclFight, WclPlayer, WclUserCharacter } from '../../core/models/wcl.models';
import { AnalysisResult } from '../../core/models/analysis.models';
import { LoadingSpinnerComponent } from '../../shared/components/loading-spinner/loading-spinner';
import { AnalysisResultComponent } from './analysis-result/analysis-result';
import { FormatDurationPipe } from '../../shared/pipes/format-duration-pipe';
import { FormatSpecPipe } from '../../shared/pipes/format-spec-pipe';

function extractCode(url: string): string {
  const m = url.match(/\/reports\/([a-zA-Z0-9]+)/);
  return m ? m[1] : url.trim();
}

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-post-raid',
  imports: [
    ReactiveFormsModule, MatFormFieldModule, MatInputModule, MatSelectModule,
    MatButtonModule, MatCardModule,
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
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  protected readonly reportControl = new FormControl('', { nonNullable: true });
  protected readonly fightControl = new FormControl<number | null>(null);
  protected readonly playerControl = new FormControl<number | null>(null);

  protected readonly loadingReport = signal(false);
  protected readonly loadingAnalysis = signal(false);
  protected readonly loadingMsg = signal('Loading…');
  protected readonly error = signal('');

  protected readonly fights = signal<WclFight[]>([]);
  protected readonly players = signal<WclPlayer[]>([]);
  protected readonly selectedFightId = toSignal(this.fightControl.valueChanges, { initialValue: this.fightControl.value });
  protected readonly selectedPlayerId = toSignal(this.playerControl.valueChanges, { initialValue: this.playerControl.value });
  protected readonly result = signal<AnalysisResult | null>(null);

  private _reportCode = '';
  private _masterAbilities: { gameID: number; name: string; icon: string }[] = [];
  private _userChars: WclUserCharacter[] = [];

  protected readonly visiblePlayers = computed(() => {
    const fightId = this.selectedFightId();
    const fight = this.fights().find(f => f.id === fightId);
    const fp = fight?.friendlyPlayers;
    return fp?.length ? this.players().filter(p => fp.includes(p.id)) : this.players();
  });

  async ngOnInit(): Promise<void> {
    const params = this.route.snapshot.queryParamMap;
    const r = params.get('report');
    if (r) {
      this.reportControl.setValue(r);
      await this.loadReport(params.get('fight') ? parseInt(params.get('fight')!, 10) : null,
                            params.get('player') ? parseInt(params.get('player')!, 10) : null);
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

    this.loadingReport.set(true);
    this.fights.set([]);
    this.players.set([]);
    this.result.set(null);

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
      const bossAttempt: Record<number, number> = {};
      this.fights.set(
        (report.fights || []).filter(f => (f.encounterID || 0) > 0).sort((a, b) => a.startTime - b.startTime).map(f => {
          const eid = f.encounterID || 0;
          bossAttempt[eid] = (bossAttempt[eid] || 0) + 1;
          return { ...f, duration_s: Math.round((f.endTime - f.startTime) / 100) / 10, attempt: bossAttempt[eid] };
        })
      );
      this.players.set(
        (report.masterData?.actors || [])
          .map(a => ({ id: a.id, name: a.name, spec: a.subType || 'Unknown', server: a.server || '' }))
          .sort((a, b) => a.name.localeCompare(b.name))
      );
      this._masterAbilities = report.masterData?.abilities || [];
      if (report.masterData?.abilities) this.icons.seed(report.masterData.abilities);

      const lastFight = this.fights()[this.fights().length - 1];
      this.fightControl.setValue(autoFight ?? lastFight?.id ?? null);
      this._applyAutoPlayer(autoPlayer);
      this._syncUrl();
      await this.analyzePlayer();
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Failed to load report.');
    } finally {
      this.loadingReport.set(false);
    }
  }

  protected async onFightChange(): Promise<void> {
    this._applyAutoPlayer(null);
    this._syncUrl();
    await this.analyzePlayer();
  }

  protected async onPlayerChange(): Promise<void> {
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
    this.loadingMsg.set('Fetching events…');
    try {
      const data = await this.analysisSvc.analyze(this._reportCode, fightId, playerId, this.fights(), this._masterAbilities);
      this.result.set(data);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Analysis failed.');
    } finally {
      this.loadingAnalysis.set(false);
    }
  }

  private _applyAutoPlayer(autoPlayer: number | null): void {
    // Always prefer the logged-in user's character over URL params
    const chars = this._userChars;
    if (chars.length) {
      const names = new Set(chars.map(c => c.name.toLowerCase()));
      const match = this.visiblePlayers().find(p => names.has(p.name.toLowerCase()));
      if (match) { this.playerControl.setValue(match.id); return; }
    }
    if (autoPlayer) { this.playerControl.setValue(autoPlayer); return; }
    this.playerControl.setValue(this.visiblePlayers()[0]?.id ?? null);
  }

  private _syncUrl(): void {
    const p: Record<string, string> = {};
    if (this._reportCode) p['report'] = this._reportCode;
    if (this.selectedFightId()) p['fight'] = String(this.selectedFightId());
    if (this.selectedPlayerId()) p['player'] = String(this.selectedPlayerId());
    this.router.navigate([], { queryParams: p, replaceUrl: true });
  }
}
