import { ChangeDetectionStrategy, Component, OnInit, OnDestroy, inject, signal } from '@angular/core';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatChipsModule } from '@angular/material/chips';
import { WclAuthService } from '../../core/services/wcl-auth';
import { WclApiService } from '../../core/services/wcl-api';
import { AnalysisService } from '../../core/services/analysis';
import { AnalysisResult } from '../../core/models/analysis.models';
import { WclFight, WclUserCharacter } from '../../core/models/wcl.models';
import { LoadingSpinnerComponent } from '../../shared/components/loading-spinner/loading-spinner';
import { AnalysisResultComponent } from '../post-raid/analysis-result/analysis-result';

const POLL_MS = 12_000;

function extractCode(url: string): string {
  const m = url.match(/\/reports\/([a-zA-Z0-9]+)/);
  return m ? m[1] : url.trim();
}

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-live',
  imports: [
    ReactiveFormsModule, MatFormFieldModule, MatInputModule, MatButtonModule,
    MatCardModule, MatChipsModule,
    LoadingSpinnerComponent, AnalysisResultComponent,
  ],
  templateUrl: './live.html',
  styleUrl: './live.scss',
})
export class LiveComponent implements OnInit, OnDestroy {
  private readonly auth = inject(WclAuthService);
  private readonly wclApi = inject(WclApiService);
  private readonly analysisSvc = inject(AnalysisService);

  protected readonly reportControl = new FormControl('', { nonNullable: true });
  protected readonly loading = signal(false);
  protected readonly error = signal('');
  protected readonly status = signal('');
  protected readonly result = signal<AnalysisResult | null>(null);
  protected readonly currentFight = signal<WclFight | null>(null);

  private _reportCode = '';
  private _masterAbilities: { gameID: number; name: string; icon: string }[] = [];
  private _pollTimer: ReturnType<typeof setInterval> | null = null;
  private _fights: WclFight[] = [];
  private _players: { id: number; name: string; spec: string; server: string }[] = [];
  private _userChars: WclUserCharacter[] = [];

  async ngOnInit(): Promise<void> {
    if (!this.auth.isLoggedIn()) return;
    this._userChars = await this.wclApi.fetchUserCharacters().catch(() => []);
    if (this._userChars.length) await this._autoStart();
  }

  ngOnDestroy(): void {
    this._stopPolling();
  }

  private async _autoStart(): Promise<void> {
    const chars = this._userChars;
    if (!chars.length) return;
    try {
      const char = chars[0];
      const d = await this.wclApi.query<{ characterData: { character: { recentReports: { data: Array<{ code: string }> } } } }>(
        `query($n:String!,$s:String!,$r:String!){characterData{character(name:$n,serverSlug:$s,serverRegion:$r){recentReports(limit:1){data{code}}}}}`,
        { n: char.name, s: char.serverSlug, r: char.serverRegion }
      );
      const code = d?.characterData?.character?.recentReports?.data?.[0]?.code;
      if (code) {
        this.reportControl.setValue(code);
        await this.startLive();
      }
    } catch { /* silent - user can enter manually */ }
  }

  protected async startLive(): Promise<void> {
    this._stopPolling();
    const url = this.reportControl.value.trim();
    if (!url) return;
    this._reportCode = extractCode(url);
    await this._poll();
    this._pollTimer = setInterval(() => this._poll(), POLL_MS);
  }

  protected stopLive(): void {
    this._stopPolling();
    this.status.set('Stopped.');
  }

  private _stopPolling(): void {
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
  }

  private async _poll(): Promise<void> {
    this.error.set('');
    this.status.set('Checking for new pulls…');
    try {
      const report = await this.wclApi.getReport(this._reportCode);
      const bossAttempt: Record<number, number> = {};
      this._fights = (report.fights || []).filter(f => (f.encounterID || 0) > 0).sort((a, b) => a.startTime - b.startTime)
        .map(f => { const eid = f.encounterID || 0; bossAttempt[eid] = (bossAttempt[eid] || 0) + 1; return { ...f, duration_s: Math.round((f.endTime - f.startTime) / 100) / 10, attempt: bossAttempt[eid] }; });
      this._players = (report.masterData?.actors || []).map(a => ({ id: a.id, name: a.name, spec: a.subType || 'Unknown', server: a.server || '' }));
      this._masterAbilities = report.masterData?.abilities || [];

      const latestFight = this._fights[this._fights.length - 1];
      if (!latestFight) { this.status.set('No boss pulls found.'); return; }
      if (this.currentFight()?.id === latestFight.id && this.result()) { this.status.set(`Last updated ${new Date().toLocaleTimeString()} · Polling every ${POLL_MS / 1000}s`); return; }

      this.currentFight.set(latestFight);
      this.loading.set(true);
      this.status.set(`Analyzing ${latestFight.name}…`);

      const names = new Set(this._userChars.map(c => c.name.toLowerCase()));
      const playerMatch = this._players.find(p => names.has(p.name.toLowerCase())) ?? this._players[0];
      if (!playerMatch) { this.loading.set(false); this.status.set('No player found.'); return; }

      const data = await this.analysisSvc.analyze(this._reportCode, latestFight.id, playerMatch.id, this._fights, this._masterAbilities);
      this.result.set(data);
      this.status.set(`Updated at ${new Date().toLocaleTimeString()} - ${latestFight.name}`);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Poll failed.');
    } finally {
      this.loading.set(false);
    }
  }
}
