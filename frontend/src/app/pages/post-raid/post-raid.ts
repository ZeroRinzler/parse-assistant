import {
  ChangeDetectionStrategy, Component,
  inject, signal, computed,
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
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { WclApiService } from '../../core/services/wcl-api';
import { LiveModeState } from '../../core/services/live-mode-state';
import { LiveReportSyncService, POLL_INTERVAL_MS } from '../../core/services/live-report-sync';
import { WclFight, WclPlayer, WclReport, PlayerDetailGroups } from '../../core/models/wcl.models';
import { LoadingSpinnerComponent } from '../../shared/components/loading-spinner/loading-spinner';
import { RotationComponent } from './rotation/rotation';
import { BurstWindowsComponent } from './burst-windows/burst-windows';
import { DefensiveComponent } from './defensive/defensive';
import { DefensiveMapAnchor } from './defensive/defensive.service';
import { GearComponent } from './gear/gear';
import { MapPanelComponent } from './map/map-panel';
import { MapFeatureService, MapAnchor } from './map/map.service';
import { FormatDurationPipe } from '../../shared/pipes/format-duration-pipe';
import { FormatSpecPipe } from '../../shared/pipes/format-spec-pipe';
import { SpecIconPipe } from '../../shared/pipes/spec-icon-pipe';
import { ClassIconPipe } from '../../shared/pipes/class-icon-pipe';
import { BossIconPipe } from '../../shared/pipes/boss-icon-pipe';
import { ArtIconComponent } from '../../shared/components/art-icon/art-icon';
import { SelectionStore } from '../../core/services/selection-store';
import { logWarn } from '../../core/log';

/** Pull a report code out of a WCL report URL, or pass through a bare code. */
export function extractCode(url: string): string {
  const m = url.match(/\/reports\/([a-zA-Z0-9]+)/);
  return m ? m[1] : url.trim();
}

/**
 * A WCL report code is exactly 16 alphanumeric characters. Validating the extracted
 * code before any network call keeps junk input (or a crawled `?report=garbage` link)
 * from reaching WCL and wasting the shared rate-limit budget.
 */
export function isValidReportCode(code: string): boolean {
  return /^[a-zA-Z0-9]{16}$/.test(code);
}

/**
 * Project the report's fights into encounter pulls: drop trash fights, order by
 * start time, and number each boss's attempts (1, 2, 3 ...) with a derived
 * duration in seconds.
 */
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

/** Project the report's master-data actors into player rows, sorted by name. */
export function buildPlayers(actors: WclReport['masterData']['actors'] = []): WclPlayer[] {
  return (actors || [])
    .map(a => ({ id: a.id, name: a.name, spec: a.subType || 'Unknown', server: a.server || '' }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The players to offer for the selected fight: when the fight lists its friendly
 * participants, restrict to those; otherwise show everyone in the report.
 */
export function visiblePlayersOf(
  fights: WclFight[],
  players: WclPlayer[],
  selectedFightId: number | null | undefined,
): WclPlayer[] {
  const fight = fights.find(f => f.id === selectedFightId);
  const fp = fight?.friendlyPlayers;
  return fp?.length ? players.filter(p => fp.includes(p.id)) : players;
}

/**
 * Choose which player to auto-select: honor an explicit (URL) choice, otherwise
 * fall back to the first visible player. Returns null when there is nobody to pick.
 */
export function pickPlayerId(
  visiblePlayers: WclPlayer[],
  autoPlayer: number | null,
): number | null {
  if (autoPlayer) return autoPlayer;
  return visiblePlayers[0]?.id ?? null;
}

/**
 * Choose which player to track across live-sync pulls.
 *
 * If the currently selected player is visible in the new pull (matched by name,
 * case-insensitively), keep them - this lets you watch a raidmate and have the
 * selection persist pull-to-pull. If they are absent, fall back to the first
 * visible player.
 */
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
  return pickPlayerId(visiblePlayers, null);
}

/**
 * Reactive-form validator for the report field: valid only when the input resolves to a
 * real 16-char WCL report code (a bare code or one inside a report URL). This keeps the
 * Analyze button disabled - and no WCL request firing - until the input is a usable log
 * reference, so typing junk never spends rate-limit budget.
 */
function reportCodeValidator(control: AbstractControl): ValidationErrors | null {
  const value = ((control.value as string | null) ?? '').trim();
  if (!value) return null; // empty is not an error (no red field); the button is disabled separately
  return isValidReportCode(extractCode(value)) ? null : { invalidReportCode: true };
}

/**
 * Resolve the selected player's spec from a raw `playerDetails` response: across
 * the dps / healers / tanks / unknown roles, find the player by id and build
 * `<spec><class>` with spaces stripped (e.g. "Subtlety" + "Rogue" -> "SubtletyRogue").
 * Returns '' when the player is not found or has no spec/class.
 */
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

/**
 * Post-raid analyzer page shell. It owns only selection (report / fight / player) and
 * live polling - no domain analysis. It resolves the minimal context (spec + encounter +
 * the player log selection) and composes the feature cards, each of which fetches and
 * computes its own slice. The map is a normal feature: the page renders `<wl-map-panel>`
 * and forwards each card's `openMap` output to the `MapFeatureService`.
 *
 * Selection is NOT mirrored to the URL: a report is loaded only by an explicit Analyze
 * action on a validated code, never auto-run from a query param. This stops crawlers
 * following a shared link from spending the shared WCL rate-limit budget. The sticky
 * player NAME (localStorage) is the only persisted selection.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-post-raid',
  imports: [
    ReactiveFormsModule, MatFormFieldModule, MatInputModule, MatSelectModule,
    MatButtonModule, MatCardModule, MatSlideToggleModule,
    LoadingSpinnerComponent, ArtIconComponent, RotationComponent, BurstWindowsComponent,
    DefensiveComponent, GearComponent, MapPanelComponent,
    FormatDurationPipe, FormatSpecPipe, SpecIconPipe, ClassIconPipe, BossIconPipe,
  ],
  // No reserved subscript strip under this page's form fields; a field grows to
  // show its mat-error only while one is active. Provided here (not app.config) so
  // the form-field import stays out of the initial bundle - this page is lazy.
  providers: [{ provide: MAT_FORM_FIELD_DEFAULT_OPTIONS, useValue: { subscriptSizing: 'dynamic' } }],
  templateUrl: './post-raid.html',
})
export class PostRaidComponent {
  private readonly wclApi = inject(WclApiService);
  private readonly mapFeature = inject(MapFeatureService);
  private readonly liveMode = inject(LiveModeState);
  private readonly liveSync = inject(LiveReportSyncService);
  private readonly selectionStore = inject(SelectionStore);

  protected readonly reportControl = new FormControl('', { nonNullable: true, validators: [reportCodeValidator] });
  protected readonly fightControl = new FormControl<number | null>(null);
  protected readonly playerControl = new FormControl<number | null>(null);
  protected readonly liveControl = new FormControl(false, { nonNullable: true });

  protected readonly loadingReport = signal(false);
  protected readonly loadingAnalysis = signal(false);
  protected readonly loadingMsg = signal('Loading…');

  // Per-card busy state. Each feature card emits `busyChange(false)` when its async load
  // settles; the page sets them true at the start of each analysis (resolveSelection). The
  // spinner stays up - and the cards stay hidden - until every card has finished loading,
  // so the cards never flash empty content between mount and first data. Init true: cards
  // are never shown before the first load completes.
  protected readonly rotationBusy = signal(true);
  protected readonly burstBusy = signal(true);
  protected readonly defensiveBusy = signal(true);
  protected readonly gearBusy = signal(true);
  protected readonly cardsBusy = computed(() =>
    this.rotationBusy() || this.burstBusy() || this.defensiveBusy() || this.gearBusy());
  protected readonly error = signal('');
  protected readonly status = signal('');

  protected readonly fights = signal<WclFight[]>([]);
  protected readonly players = signal<WclPlayer[]>([]);
  protected readonly selectedFightId = toSignal(this.fightControl.valueChanges, { initialValue: this.fightControl.value });
  protected readonly selectedPlayerId = toSignal(this.playerControl.valueChanges, { initialValue: this.playerControl.value });
  protected readonly liveSyncEnabled = toSignal(this.liveControl.valueChanges, { initialValue: this.liveControl.value });

  /** Resolved spec of the selected player; drives every feature card. Empty until resolved. */
  protected readonly spec = signal('');

  /** playerDetails for the selected fight (all roles), kept so the dropdown can show each
   *  player's spec icon - `actor.subType` is class-only since Midnight, so the dropdown can't
   *  resolve specs on its own. */
  protected readonly playerDetailGroups = signal<PlayerDetailGroups>({});

  /** Current report code, driven by loadReport(). Used by the polling pipeline. */
  protected readonly reportCode = signal('');

  private _enemies: { id: number; name: string; gameID: number }[] = [];

  protected readonly visiblePlayers = computed(() =>
    visiblePlayersOf(this.fights(), this.players(), this.selectedFightId()));

  /** Per-player resolved spec folder (e.g. 'SubtletyRogue') for the visible roster, for the
   *  player dropdown's spec icon. Empty for a player until playerDetails for the fight loads. */
  protected readonly playerSpecs = computed(() => {
    const groups = this.playerDetailGroups();
    const result: Record<number, string> = {};
    for (const player of this.visiblePlayers()) result[player.id] = specOf(groups, player.id);
    return result;
  });

  /** The selected fight row, so the select trigger can render its boss icon + label. */
  protected readonly selectedFight = computed(() =>
    this.fights().find(f => f.id === this.selectedFightId()));

  /** The selected player, so the select trigger can render its spec icon + name. */
  protected readonly selectedPlayer = computed(() =>
    this.visiblePlayers().find(p => p.id === this.selectedPlayerId()));

  /** Encounter id of the selected fight, passed to every feature card. */
  protected readonly selectedEncounterId = computed(() =>
    this.fights().find(f => f.id === this.selectedFightId())?.encounterID ?? 0);

  /** Duration of the selected fight, for the defensive window time axis. */
  protected readonly selectedFightDuration = computed(() =>
    this.fights().find(f => f.id === this.selectedFightId())?.duration_s ?? 0);

  /** The cards render once a spec, fight, player and encounter are all resolved. */
  protected readonly ready = computed(() =>
    !!this.spec() && !!this.reportCode() && !!this.selectedFightId() && !!this.selectedPlayerId() && !!this.selectedEncounterId());

  /** Map is available once the map feature has loaded top-parse positions for this fight. */
  protected mapReady(): boolean { return this.mapFeature.ready(); }

  /** A feature card asked to open the map; the page forwards it to the map feature. */
  protected onOpenMap(anchor: MapAnchor): void {
    this.mapFeature.openAt(anchor);
  }

  /** Defensive cards carry a reference enemy gameID; convert it to a MapAnchor reference. */
  protected onDefensiveOpenMap(anchor: DefensiveMapAnchor): void {
    this.mapFeature.openAt({
      timeS: anchor.timeS,
      reference: anchor.refGameId != null ? { kind: 'enemy', gameId: anchor.refGameId } : { kind: 'boss' },
    });
  }

  // Declarative polling pipeline. Must live in a field initializer so that
  // toObservable() and takeUntilDestroyed() run inside the injection context.
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

  protected onPaste(): void {
    // The pasted text is committed to the control after this event fires; defer a tick so
    // loadReport() reads the updated value, then load it (loadReport validates first, so a
    // pasted non-code never reaches WCL).
    setTimeout(() => void this.loadReport());
  }

  protected async loadReport(): Promise<void> {
    this.error.set('');
    const code = extractCode(this.reportControl.value.trim());
    // Guard before any network call: an invalid code never reaches WCL. The Analyze button
    // is already disabled while invalid; this also covers the Enter-key path.
    if (!isValidReportCode(code)) {
      if (code) this.error.set('Enter a valid Warcraft Logs report URL or 16-character report code.');
      return;
    }
    // Setting reportCode to '' stops any active poll before the fetch completes.
    this.reportCode.set('');

    this.loadingReport.set(true);
    this.fights.set([]);
    this.players.set([]);
    this.spec.set('');
    this.playerDetailGroups.set({});
    this.mapFeature.clear();

    try {
      this.loadingMsg.set('Fetching report from WCL…');
      const report = await this.wclApi.getReport(code);
      this._applyReport(report);

      const lastFight = this.fights()[this.fights().length - 1];
      this.fightControl.setValue(lastFight?.id ?? null);
      this._applyAutoPlayer();
      // Set reportCode last - this activates the polling pipeline if liveSync is on.
      this.reportCode.set(code);
      this._persistPlayerName();
      await this.resolveSelection();
    } catch (err) {
      logWarn('PostRaidComponent.loadReport', err);
      this.error.set(err instanceof Error ? err.message : 'Failed to load report.');
    } finally {
      this.loadingReport.set(false);
    }
  }

  /** Project a freshly fetched report into fight/player state. */
  private _applyReport(report: WclReport): void {
    this.fights.set(buildFights(report.fights));
    this.players.set(buildPlayers(report.masterData?.actors));
    this._enemies = report.masterData?.enemies ?? [];
  }

  protected onLiveToggle(): void {
    this.liveMode.active.set(this.liveControl.value);
    // Live sync owns the fight selection: disable the control (setValue from the
    // poll still works on a disabled control) instead of faking it with opacity +
    // pointer-events, which left the select keyboard-operable.
    if (this.liveControl.value) this.fightControl.disable();
    else this.fightControl.enable();
  }

  private async _pollOnce(): Promise<void> {
    this.error.set('');
    this.status.set('Checking for new pulls…');
    try {
      const report = await this.wclApi.getReport(this.reportCode());
      this._applyReport(report);

      const latest = this.fights()[this.fights().length - 1];
      if (!latest) { this.status.set('No boss pulls found.'); return; }

      // Cheap-diff: latest pull unchanged and already analyzed - skip re-analysis.
      if (this.selectedFightId() === latest.id && this.ready()) {
        this.status.set(`Last updated ${new Date().toLocaleTimeString()} · Polling every ${POLL_INTERVAL_MS / 1000}s`);
        return;
      }

      const currentName = this.players().find(player => player.id === this.selectedPlayerId())?.name ?? null;
      const visible = visiblePlayersOf(this.fights(), this.players(), latest.id);
      this.fightControl.setValue(latest.id);
      this.playerControl.setValue(pickLivePlayerId(visible, currentName));
      this._persistPlayerName();
      await this.resolveSelection();
      this.status.set(`Updated ${new Date().toLocaleTimeString()} · ${latest.name}`);
    } catch (err) {
      logWarn('PostRaidComponent._pollOnce', err);
      this.error.set(err instanceof Error ? err.message : 'Poll failed.');
    }
  }

  protected async onFightChange(): Promise<void> {
    if (this.liveSyncEnabled()) return;
    this._applyAutoPlayer();
    this._persistPlayerName();
    await this.resolveSelection();
  }

  protected async onPlayerChange(): Promise<void> {
    if (this.liveSyncEnabled()) return;
    this._persistPlayerName();
    await this.resolveSelection();
  }

  /**
   * Resolve the spec for the selected player and prepare the map context. The feature
   * cards self-load from their `spec`/`encounterId`/selection inputs; this only does
   * the cross-cutting work a shell legitimately owns (spec resolution + map prepare).
   */
  protected async resolveSelection(): Promise<void> {
    this.error.set('');
    const fightId = this.selectedFightId();
    const playerId = this.selectedPlayerId();
    this.spec.set('');
    this.mapFeature.clear();
    if (!fightId || !playerId) return;

    this.loadingAnalysis.set(true);
    this.loadingMsg.set('Resolving spec…');
    try {
      const groups = await this.wclApi.getPlayerDetails(this.reportCode(), fightId);
      this.playerDetailGroups.set(groups);
      const spec = specOf(groups, playerId);
      if (!spec) { this.error.set('Could not resolve the selected player\'s spec.'); return; }
      this.spec.set(spec);

      // Mark every card busy before they mount/reload, so the spinner stays up continuously
      // until each card emits busyChange(false) - no gap where the cards render empty.
      this.rotationBusy.set(true);
      this.burstBusy.set(true);
      this.defensiveBusy.set(true);
      this.gearBusy.set(true);
      this.loadingMsg.set('Analyzing your log…');

      const fight = this.fights().find(f => f.id === fightId);
      if (fight) void this.mapFeature.prepare(this.reportCode(), fight, playerId, spec, this._enemies);
    } catch (err) {
      logWarn('PostRaidComponent.resolveSelection', err);
      this.error.set(err instanceof Error ? err.message : 'Failed to resolve selection.');
    } finally {
      this.loadingAnalysis.set(false);
    }
  }

  private _applyAutoPlayer(): void {
    // Stick to the saved player name so the same character stays selected across fights and
    // logs (actor ids are not stable across reports).
    const stickyName = this.selectionStore.loadPostRaid()?.playerName ?? null;
    this.playerControl.setValue(pickLivePlayerId(this.visiblePlayers(), stickyName));
  }

  private _persistPlayerName(): void {
    // Persist only the player NAME, and only when one resolves - never clobber the sticky
    // value with null while nothing is selected (e.g. mid report switch). Selection is not
    // mirrored to the URL (see the class doc): this localStorage value is the only sticky state.
    const playerName = this.players().find(player => player.id === this.selectedPlayerId())?.name ?? null;
    if (playerName) this.selectionStore.savePostRaid({ playerName });
  }
}
