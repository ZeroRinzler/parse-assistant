import { ChangeDetectionStrategy, Component, OnInit, DestroyRef, inject, signal } from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subscription, from, fromEvent, interval, merge, of } from 'rxjs';
import { exhaustMap, filter } from 'rxjs/operators';
import { Router } from '@angular/router';
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
export class LiveComponent implements OnInit {
  private readonly auth = inject(WclAuthService);
  private readonly wclApi = inject(WclApiService);
  private readonly analysisSvc = inject(AnalysisService);
  private readonly router = inject(Router);
  private readonly document = inject(DOCUMENT);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly reportControl = new FormControl('', { nonNullable: true });
  protected readonly loading = signal(false);
  protected readonly error = signal('');
  protected readonly status = signal('');
  protected readonly result = signal<AnalysisResult | null>(null);
  protected readonly currentFight = signal<WclFight | null>(null);

  private _reportCode = '';
  private _masterAbilities: { gameID: number; name: string; icon: string }[] = [];
  private _pollSub: Subscription | null = null;
  private _fights: WclFight[] = [];
  private _players: { id: number; name: string; spec: string; server: string }[] = [];
  private _userChars: WclUserCharacter[] = [];

  async ngOnInit(): Promise<void> {
    if (!this.auth.isLoggedIn()) return;
    this._userChars = await this.wclApi.fetchUserCharacters().catch(() => []);
    if (this._userChars.length) await this._autoStart();
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
        this.startLive();
      }
    } catch { /* silent - user can enter manually */ }
  }

  protected startLive(): void {
    this._pollSub?.unsubscribe();
    const url = this.reportControl.value.trim();
    if (!url) return;
    this._reportCode = extractCode(url);

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
      exhaustMap(() => {
        lastPollAt = Date.now();
        return from(this._poll());
      }),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe();
  }

  protected stopLive(): void {
    this._pollSub?.unsubscribe();
    this._pollSub = null;
    this.status.set('Stopped.');
  }

  private _syncUrl(fightId: number, playerId: number): void {
    const p: Record<string, string> = {};
    if (this._reportCode) p['report'] = this._reportCode;
    if (fightId) p['fight'] = String(fightId);
    if (playerId) p['player'] = String(playerId);
    this.router.navigate([], { queryParams: p, replaceUrl: true });
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

      this._syncUrl(latestFight.id, playerMatch.id);
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
