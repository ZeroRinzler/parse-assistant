import {
  ChangeDetectionStrategy, Component,
  inject, signal, computed, effect,
} from '@angular/core';
import { toObservable, toSignal, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { AbstractControl, FormControl, ReactiveFormsModule, ValidationErrors } from '@angular/forms';
import { EMPTY, combineLatest, from, merge, of } from 'rxjs';
import { distinctUntilChanged, exhaustMap, map, switchMap, tap } from 'rxjs/operators';
import { MAT_FORM_FIELD_DEFAULT_OPTIONS, MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { WclApiService } from '../../core/services/wcl-api';
import { LiveReportSyncService, POLL_INTERVAL_S } from '../../core/services/live-report-sync';
import { WclFight, WclPlayer, WclReport, PlayerDetailGroups } from '../../core/models/wcl.models';
import { ClipAnchor } from '../../core/models/capture.models';
import { LoadingSpinnerComponent } from '../../shared/components/loading-spinner/loading-spinner';
import { BenchEmptyBannerComponent } from '../../shared/components/bench-empty-banner/bench-empty-banner';
import { PullOverviewComponent } from './pull-overview/pull-overview';
import { RotationComponent } from './rotation/rotation';
import { BurstWindowsComponent } from './burst-windows/burst-windows';
import { DefensiveComponent } from './defensive/defensive';
import { DefensiveMapAnchor } from './defensive/defensive.service';
import { GearComponent } from './gear/gear';
import { MapPanelComponent } from './map/map-panel';
import { MapFeatureService, MapAnchor } from './map/map.service';
import { LiveCaptureFeatureService } from './live/live-capture.service';
import { LiveControlsComponent } from './live/live-controls';
import { ClipPanelComponent } from './live/clip-panel';
import { FormatDurationPipe } from '../../shared/pipes/format-duration-pipe';
import { FormatSpecPipe } from '../../shared/pipes/format-spec-pipe';
import { SpecIconPipe } from '../../shared/pipes/spec-icon-pipe';
import { ClassIconPipe } from '../../shared/pipes/class-icon-pipe';
import { BossIconPipe } from '../../shared/pipes/boss-icon-pipe';
import { ArtIconComponent } from '../../shared/components/art-icon/art-icon';
import { LatestRun } from '../../shared/latest-run';
import { SelectionStore } from '../../core/services/selection-store';
import { logWarn } from '../../core/log';
import { Result, LoadError, permanent } from '../../core/result';
import { toLoadError } from '../../core/http-load-error';
import { LoadStateComponent, RenderableLoadError } from '../../shared/components/load-state/load-state';

export function extractCode(url: string): string {
  const m = url.match(/\/reports\/([a-zA-Z0-9]+)/);
  return m ? m[1] : url.trim();
}

export function extractFightId(url: string): number | null {
  const m = url.match(/[#?&]fight=(\d+)/);
  const id = m ? Number(m[1]) : NaN;
  return Number.isInteger(id) && id > 0 ? id : null;
}

// Validating before any network call keeps junk input (or a crawled ?report=garbage link) from wasting the shared rate-limit budget.
export function isValidReportCode(code: string): boolean {
  return /^[a-zA-Z0-9]{16}$/.test(code);
}

const MYTHIC_PLUS_DIFFICULTY = 10;

export function unsupportedEncounterNotice(fightName: string): string {
  return `${fightName} is a Mythic+ boss. Pick a raid pull.`;
}

export function isKeystoneFight(difficulty: number | null | undefined): boolean {
  return difficulty === MYTHIC_PLUS_DIFFICULTY;
}

export function buildFights(fights: WclReport['fights'] = []): WclFight[] {
  const bossAttempt: Record<number, number> = {};
  return (fights || [])
    .filter(f => (f.encounterID || 0) > 0)
    .sort((a, b) => a.startTime - b.startTime)
    .map(f => {
      const eid = f.encounterID || 0;
      bossAttempt[eid] = (bossAttempt[eid] || 0) + 1;
      return { ...f, duration_s: Math.round((f.endTime - f.startTime) / 100) / 10, attempt: bossAttempt[eid] };
    });
}

export function buildPlayers(actors: WclReport['masterData']['actors'] = []): WclPlayer[] {
  return (actors || [])
    .map(a => ({ id: a.id, name: a.name, spec: a.subType || 'Unknown', server: a.server || '' }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function visiblePlayersOf(
  fights: WclFight[],
  players: WclPlayer[],
  selectedFightId: number | null | undefined,
): WclPlayer[] {
  const fight = fights.find(f => f.id === selectedFightId);
  const fp = fight?.friendlyPlayers;
  return fp?.length ? players.filter(p => fp.includes(p.id)) : players;
}

export type LivePollAction = 'none' | 'skip' | 'analyze';

/** 'analyze' also covers an unfinished selection, so a failed resolve retries on the next tick. */
export function livePollActionOf(
  fights: WclFight[],
  selectedFightId: number | null | undefined,
  analyzed: boolean,
): LivePollAction {
  const latest = fights[fights.length - 1];
  if (!latest) return 'none';
  return latest.id === selectedFightId && analyzed ? 'skip' : 'analyze';
}

// Keeps the currently selected player if visible in the new pull (matched by name, case-insensitively); else falls back to the first visible player.
export function pickLivePlayerId(
  visiblePlayers: WclPlayer[],
  currentPlayerName: string | null,
): number | null {
  if (currentPlayerName) {
    const sticky = visiblePlayers.find(
      p => p.name.toLowerCase() === currentPlayerName.toLowerCase(),
    );
    if (sticky) return sticky.id;
  }
  return visiblePlayers[0]?.id ?? null;
}

// Keeps the Analyze button disabled - and no WCL request firing - until the input resolves to a usable report code.
function reportCodeValidator(control: AbstractControl): ValidationErrors | null {
  const value = ((control.value as string | null) ?? '').trim();
  if (!value) return null; // empty is not an error (no red field); the button is disabled separately
  return isValidReportCode(extractCode(value)) ? null : { invalidReportCode: true };
}

// Builds <spec><class> with spaces stripped (e.g. "Subtlety" + "Rogue" -> "SubtletyRogue"); '' when not found.
export function specOf(groups: PlayerDetailGroups, playerId: number): string {
  for (const role of ['dps', 'healers', 'tanks', 'unknown']) {
    for (const player of (groups[role] ?? [])) {
      if (player.id !== playerId) continue;
      const className = (player.type ?? '').replace(/ /g, '');
      const spec = ((player.specs ?? [])[0]?.spec ?? '').replace(/ /g, '');
      return spec && className ? spec + className : '';
    }
  }
  return '';
}

// Selection is NOT mirrored to the URL: a report loads only via an explicit Analyze action, never auto-run from a query param, so a crawled link never spends the shared WCL rate-limit budget.
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-post-raid',
  imports: [
    ReactiveFormsModule, MatFormFieldModule, MatInputModule, MatSelectModule,
    MatButtonModule, MatCardModule,
    LoadingSpinnerComponent, BenchEmptyBannerComponent, LoadStateComponent, ArtIconComponent, PullOverviewComponent, RotationComponent, BurstWindowsComponent,
    DefensiveComponent, GearComponent, MapPanelComponent, LiveControlsComponent, ClipPanelComponent,
    FormatDurationPipe, FormatSpecPipe, SpecIconPipe, ClassIconPipe, BossIconPipe,
  ],
  // Provided here (not app.config) so the form-field import stays out of the initial bundle - this page is lazy.
  providers: [{ provide: MAT_FORM_FIELD_DEFAULT_OPTIONS, useValue: { subscriptSizing: 'dynamic' } }],
  templateUrl: './post-raid.html',
})
export class PostRaidComponent {
  private readonly wclApi = inject(WclApiService);
  private readonly mapFeature = inject(MapFeatureService);
  protected readonly liveCapture = inject(LiveCaptureFeatureService);
  private readonly liveSync = inject(LiveReportSyncService);
  private readonly selectionStore = inject(SelectionStore);

  protected readonly reportControl = new FormControl('', { nonNullable: true, validators: [reportCodeValidator] });
  protected readonly fightControl = new FormControl<number | null>(null);
  protected readonly playerControl = new FormControl<number | null>(null);

  constructor() {
    // Live sync owns the fight selection: disable the control while it drives it (setValue from the poll still works on a disabled control).
    effect(() => {
      if (this.liveCapture.liveEnabled()) this.fightControl.disable();
      else this.fightControl.enable();
    });
  }

  protected readonly loadingReport = signal(false);
  protected readonly loadingAnalysis = signal(false);
  protected readonly loadingMsg = signal('Loading…');

  // Starts true, and the spinner stays up until every card emits busyChange(false), so the cards never flash empty content between mount and first data.
  protected readonly pullOverviewBusy = signal(true);
  protected readonly rotationBusy = signal(true);
  protected readonly burstBusy = signal(true);
  protected readonly defensiveBusy = signal(true);
  protected readonly gearBusy = signal(true);
  protected readonly cardsBusy = computed(() =>
    this.pullOverviewBusy() || this.rotationBusy() || this.burstBusy() || this.defensiveBusy() || this.gearBusy());

  // The banner shows when none have a bench. Rotation counts via its offensives, which is also what gates its rules card.
  protected readonly rotationAvailable = signal(false);
  protected readonly burstAvailable = signal(false);
  protected readonly defensiveAvailable = signal(false);
  protected readonly gearAvailable = signal(false);
  protected readonly benchAvailable = computed(() =>
    this.rotationAvailable() || this.burstAvailable() || this.defensiveAvailable() || this.gearAvailable());

  // `notice` carries the non-failure states the taxonomy does not cover (invalid code, zero-pull report).
  protected readonly loadError = signal<RenderableLoadError | null>(null);
  protected readonly notice = signal('');

  protected readonly fights = signal<WclFight[]>([]);
  protected readonly players = signal<WclPlayer[]>([]);
  protected readonly selectedFightId = toSignal(this.fightControl.valueChanges, { initialValue: this.fightControl.value });
  protected readonly selectedPlayerId = toSignal(this.playerControl.valueChanges, { initialValue: this.playerControl.value });
  protected readonly liveSyncEnabled = this.liveCapture.liveEnabled;

  protected readonly spec = signal('');

  // actor.subType is class-only since Midnight, so the dropdown resolves each player's spec from playerDetails instead.
  protected readonly playerDetailGroups = signal<PlayerDetailGroups>({});

  protected readonly reportCode = signal('');

  /** Report clock (unix epoch ms), the shared timebase for correlating clips to fights. */
  protected readonly reportStartTime = signal(0);

  private _enemies: { id: number; name: string; gameID: number }[] = [];

  private readonly reportRun = new LatestRun();

  private readonly selectionRun = new LatestRun();

  protected readonly visiblePlayers = computed(() =>
    visiblePlayersOf(this.fights(), this.players(), this.selectedFightId()));

  protected readonly playerSpecs = computed(() => {
    const groups = this.playerDetailGroups();
    const result: Record<number, string> = {};
    for (const player of this.visiblePlayers()) result[player.id] = specOf(groups, player.id);
    return result;
  });

  protected readonly selectedFight = computed(() =>
    this.fights().find(f => f.id === this.selectedFightId()));

  protected readonly selectedPlayer = computed(() =>
    this.visiblePlayers().find(p => p.id === this.selectedPlayerId()));

  protected readonly selectedEncounterId = computed(() =>
    this.fights().find(f => f.id === this.selectedFightId())?.encounterID ?? 0);

  protected readonly ready = computed(() =>
    !!this.spec() && !!this.reportCode() && !!this.selectedFightId() && !!this.selectedPlayerId() && !!this.selectedEncounterId());

  protected readonly mapReady = this.mapFeature.ready;

  protected onOpenMap(anchor: MapAnchor): void {
    this.mapFeature.openAt(anchor);
  }

  protected onDefensiveOpenMap(anchor: DefensiveMapAnchor): void {
    this.mapFeature.openAt({
      timeS: anchor.timeS,
      windowLengthS: anchor.windowLengthS,
      reference: anchor.refGameId != null ? { kind: 'enemy', gameId: anchor.refGameId } : { kind: 'boss' },
    });
  }

  protected readonly clipReady = this.liveCapture.clipReady;

  protected onOpenClip(anchor: ClipAnchor): void {
    this.liveCapture.openClip(anchor);
  }

  // Must live in a field initializer so that toObservable() and takeUntilDestroyed() run inside the injection context.
  private readonly _pollingSub = combineLatest([
    toObservable(this.liveSyncEnabled),
    toObservable(this.reportCode),
  ]).pipe(
    tap(([live, code]) => {
      if (live && !code) this.liveCapture.setStatus('Load a report to start live sync.');
      else if (!live) this.liveCapture.setStatus('');
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

  protected onPaste(): void {
    // Defers a tick so loadReport() reads the control's updated value, since the paste commits after this event fires.
    setTimeout(() => void this.loadReport());
  }

  // Folding `missing` to the notice keeps the shell exhaustive over the taxonomy without leaking a raw string.
  private _showError(result: Result<never, LoadError>): void {
    if (result.ok) return; // toLoadError / permanent never return ok; this narrows the union
    if (result.error.kind === 'missing') this.notice.set(result.error.message);
    else this.loadError.set(result.error);
  }

  protected async loadReport(): Promise<void> {
    this.loadError.set(null);
    this.notice.set('');
    const rawInput = this.reportControl.value;
    const code = extractCode(rawInput.trim());
    // The Analyze button is already disabled while invalid; this guard also covers the Enter-key path.
    if (!isValidReportCode(code)) {
      if (code) this.notice.set('Enter a valid Warcraft Logs report URL or 16-character report code.');
      return;
    }
    const run = this.reportRun.begin();
    // Setting reportCode to '' stops any active poll before the fetch completes.
    this.reportCode.set('');

    this.loadingReport.set(true);
    this.fights.set([]);
    this.players.set([]);
    this.spec.set('');
    this.playerDetailGroups.set({});
    this.selectionRun.cancel();
    this.mapFeature.clear();
    this.liveCapture.clear();

    try {
      this.loadingMsg.set('Fetching report from Warcraft Logs…');
      const report = await this.wclApi.getReport(code);
      if (!this.reportRun.isCurrent(run)) return;
      this._applyReport(report);

      const requestedId = extractFightId(rawInput);
      const requestedFight = requestedId != null ? this.fights().find(f => f.id === requestedId) : undefined;
      const targetFight = requestedFight ?? this.fights()[this.fights().length - 1];
      this.fightControl.setValue(targetFight?.id ?? null);
      // Without this a zero-pull log is a successful load that looks like nothing happened.
      if (!this.fights().length) this.notice.set('No boss pulls found in this report.');
      this._applyAutoPlayer();
      // Set reportCode last - this activates the polling pipeline if liveSync is on.
      this.reportCode.set(code);
      await this.resolveSelection();
    } catch (err) {
      logWarn('PostRaidComponent.loadReport', err);
      if (this.reportRun.isCurrent(run)) this._showError(toLoadError(err, 'post-raid.load-report'));
    } finally {
      if (this.reportRun.isCurrent(run)) this.loadingReport.set(false);
    }
  }

  private _applyReport(report: WclReport): void {
    this.fights.set(buildFights(report.fights));
    this.players.set(buildPlayers(report.masterData?.actors));
    this.reportStartTime.set(report.startTime);
    this._enemies = report.masterData?.enemies ?? [];
  }

  private async _pollOnce(): Promise<void> {
    this.loadError.set(null);
    this.liveCapture.setStatus('Checking for new pulls…');
    // Pin the report this poll fetches; a mid-flight live-off or report switch must abandon its late writes.
    const code = this.reportCode();
    try {
      // Skipping the apply on an unchanged report keeps the rebuilt fight objects from retriggering the cards' own WCL fetches.
      const probedFights = buildFights(await this.wclApi.getReportFights(code));
      if (this._pollSuperseded(code)) return;
      const action = livePollActionOf(probedFights, this.selectedFightId(), this.ready());
      if (action === 'none') { this.liveCapture.setStatus('No boss pulls found.'); return; }
      if (action === 'skip') {
        this.liveCapture.setStatus(`Last updated ${new Date().toLocaleTimeString()}, polling every ${POLL_INTERVAL_S}s`);
        return;
      }

      const report = await this.wclApi.getReport(code);
      if (this._pollSuperseded(code)) return;
      this._applyReport(report);

      const latest = this.fights()[this.fights().length - 1];
      if (!latest) { this.liveCapture.setStatus('No boss pulls found.'); return; }
      // A poll that lands a pull clears the zero-pull notice from the initial empty load.
      this.notice.set('');

      const currentName = this.players().find(player => player.id === this.selectedPlayerId())?.name ?? null;
      const visible = visiblePlayersOf(this.fights(), this.players(), latest.id);
      this.fightControl.setValue(latest.id);
      this.playerControl.setValue(pickLivePlayerId(visible, currentName));
      await this.resolveSelection();
      if (this._pollSuperseded(code)) return;
      this.liveCapture.setStatus(`Updated ${new Date().toLocaleTimeString()} - ${latest.name}`);
    } catch (err) {
      logWarn('PostRaidComponent._pollOnce', err);
      if (this._pollSuperseded(code)) return;
      this._showError(toLoadError(err, 'post-raid.poll'));
      // Overwrite the in-flight "Checking..." status so the strip stops claiming a live check.
      this.liveCapture.setStatus('Live sync error, retrying on the next check.');
    }
  }

  private _pollSuperseded(code: string): boolean {
    return !this.liveSyncEnabled() || this.reportCode() !== code;
  }

  protected async onFightChange(): Promise<void> {
    if (this.liveSyncEnabled()) return;
    this._applyAutoPlayer();
    await this.resolveSelection();
  }

  protected async onPlayerChange(): Promise<void> {
    // Persist only on an explicit pick, so an auto-select fallback never overwrites the sticky name.
    this._persistPlayerName();
    await this.resolveSelection();
  }

  // The feature cards self-load from their spec/encounterId/selection inputs; this only does the cross-cutting work a shell owns.
  protected async resolveSelection(): Promise<void> {
    const run = this.selectionRun.begin();
    this.loadError.set(null);
    const fightId = this.selectedFightId();
    const playerId = this.selectedPlayerId();
    this.spec.set('');
    this.loadingAnalysis.set(false);
    this.mapFeature.clear();
    this.liveCapture.clear();
    if (!fightId || !playerId) return;
    this.notice.set('');

    const fight = this.fights().find(f => f.id === fightId);
    if (isKeystoneFight(fight?.difficulty)) { this.notice.set(unsupportedEncounterNotice(fight?.name ?? '')); return; }

    this.loadingAnalysis.set(true);
    this.loadingMsg.set('Fetching player data from Warcraft Logs…');
    try {
      const groups = await this.wclApi.getPlayerDetails(this.reportCode(), fightId);
      if (!this.selectionRun.isCurrent(run)) return;
      this.playerDetailGroups.set(groups);
      const spec = specOf(groups, playerId);
      // Unmappable spec is a semantic dead end, not retriable: permanent, not transient.
      if (!spec) { this._showError(permanent('Could not resolve the selected player\'s spec.', 'post-raid.spec-resolve')); return; }
      this.spec.set(spec);

      // Marks every card busy before they mount/reload, so the spinner stays up with no gap where the cards render empty.
      this.pullOverviewBusy.set(true);
      this.rotationBusy.set(true);
      this.burstBusy.set(true);
      this.defensiveBusy.set(true);
      this.gearBusy.set(true);
      this.loadingMsg.set('Fetching analysis data from Warcraft Logs…');

      if (fight) {
        void this.mapFeature.prepare(this.reportCode(), fight, playerId, spec, this._enemies);
        this.liveCapture.prepare(this.reportCode(), this.reportStartTime(), fight);
      }
    } catch (err) {
      logWarn('PostRaidComponent.resolveSelection', err);
      if (this.selectionRun.isCurrent(run)) this._showError(toLoadError(err, 'post-raid.resolve-selection'));
    } finally {
      if (this.selectionRun.isCurrent(run)) this.loadingAnalysis.set(false);
    }
  }

  private _applyAutoPlayer(): void {
    // Sticks to the saved player NAME, not actor id, since actor ids are not stable across reports.
    const stickyName = this.selectionStore.loadPostRaid()?.playerName ?? null;
    this.playerControl.setValue(pickLivePlayerId(this.visiblePlayers(), stickyName));
  }

  private _persistPlayerName(): void {
    // Guard the write so an unresolved selection never overwrites the sticky name with null.
    const playerName = this.players().find(player => player.id === this.selectedPlayerId())?.name ?? null;
    if (playerName) this.selectionStore.savePostRaid({ playerName });
  }
}
