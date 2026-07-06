import {
  ChangeDetectionStrategy, Component, DestroyRef, ElementRef, computed, effect,
  inject, signal, viewChild,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { ReferenceSelector } from '../../../core/models/positioning.models';
import { FormatDurationPipe } from '../../../shared/pipes/format-duration-pipe';
import { LoadStateComponent, RenderableLoadError } from '../../../shared/components/load-state/load-state';
import { MapFeatureService } from './map.service';
import {
  RelPos, ParseTimelines, buildParseTimelines, buildTrail, positionAt, toReferenceLocal,
  parsePointsAt, parseTrailsOf,
} from './map-draw';

const STEP_S = 0.5;
/** Playback advances the scrubber by real elapsed wall-time, clamped per frame so a
 *  backgrounded-then-resumed tab does not jump the scrubber by the whole elapsed gap. */
const MAX_FRAME_DT_S = 0.1;

/**
 * The positioning map canvas: the top-parse benchmark plus the analysed player's own trail.
 * Injects one service (`MapFeatureService`) and reads its bench/live/anchor/reference signals.
 * Reference is switchable; a scrubber steps through the window around the anchor. Design tokens
 * are resolved at draw time (no hardcoded colors).
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-map-canvas',
  imports: [MatButtonModule, MatIconModule, MatFormFieldModule, MatSelectModule, FormatDurationPipe, LoadStateComponent],
  templateUrl: './map-canvas.html',
})
export class MapCanvasComponent {
  private readonly map = inject(MapFeatureService);

  protected readonly positions = this.map.positions;
  protected readonly live = this.map.live;
  protected readonly anchorTime = this.map.anchorTime;
  /** Renderable bench/overlay failure; a `missing` bench is excluded (it shows the empty placeholder). */
  protected readonly loadError = computed<RenderableLoadError | null>(() => {
    const error = this.map.error();
    return error && error.kind !== 'missing' ? error : null;
  });

  protected readonly selector = signal<ReferenceSelector>({ kind: 'boss' });
  protected readonly scrubT = signal(0);
  protected readonly playing = signal(false);
  private rafId: number | null = null;
  private lastFrameMs = 0;
  private readonly canvas = viewChild<ElementRef<HTMLCanvasElement>>('canvas');

  protected readonly refEnemies = computed(() => {
    const positions = this.positions();
    if (!positions) return [];
    const seen = new Map<number, { gameId: number; name: string; isBoss: boolean }>();
    for (const parse of positions.parses) {
      for (const enemy of parse.enemies) {
        if (enemy.game_id == null) continue;
        const current = seen.get(enemy.game_id);
        if (!current) seen.set(enemy.game_id, { gameId: enemy.game_id, name: enemy.name, isBoss: enemy.is_boss });
        else if (enemy.is_boss) current.isBoss = true;
      }
    }
    return [...seen.values()].sort((a, b) => (b.isBoss ? 1 : 0) - (a.isBoss ? 1 : 0));
  });

  protected readonly refValue = computed(() => {
    const selector = this.selector();
    return selector.kind === 'boss' ? 'boss' : selector.gameId;
  });

  protected readonly preS = this.map.preS;
  protected readonly postS = this.map.postS;
  protected readonly windowStart = computed(() => this.anchorTime() - this.preS());
  protected readonly windowEnd = computed(() => this.anchorTime() + this.postS());

  /**
   * Player + reference timelines per parse, rebuilt only when the bench or reference changes, never
   * per scrubbed frame. Scaling every stored row into a sample is the expensive step, so caching it
   * here keeps playback cheap: each frame just interpolates the cached timelines.
   */
  private readonly parseTimelines = computed<ParseTimelines[]>(() => {
    const positions = this.positions();
    return positions ? buildParseTimelines(positions, this.selector()) : [];
  });

  private readonly benchTrails = computed(() =>
    parseTrailsOf(this.parseTimelines(), this.anchorTime(), this.preS(), this.postS(), STEP_S));

  private readonly liveRefId = computed(() => {
    const live = this.live();
    if (!live) return null;
    const selector = this.selector();
    return selector.kind === 'boss' ? live.bossActorId : (live.refActorByGameId.get(selector.gameId) ?? null);
  });

  private readonly liveTrail = computed<RelPos[]>(() => {
    const live = this.live();
    const refId = this.liveRefId();
    if (!live || refId == null) return [];
    return buildTrail(live.playerId, refId, live.timelines, this.anchorTime(), this.preS(), this.postS(), STEP_S);
  });

  /** Readout at the scrubbed moment: the top-parse cluster centroid + the player's position. */
  protected readonly readout = computed(() => {
    if (!this.positions()) return null;
    const t = this.scrubT();
    const points = parsePointsAt(this.parseTimelines(), t);
    let centroid: { fwd: number; right: number } | null = null;
    if (points.length) {
      centroid = {
        fwd: points.reduce((sum, point) => sum + point.fwd, 0) / points.length,
        right: points.reduce((sum, point) => sum + point.right, 0) / points.length,
      };
    }
    const player = this.livePlayerAt(t);
    return { centroid, player };
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => this.stopTimer());
    // New context (anchor moved): reset reference, jump to the anchor, stop playback.
    effect(() => {
      this.anchorTime();
      this.selector.set(this.map.reference());
      this.pause();
      this.scrubT.set(this.anchorTime());
    });
    effect(() => {
      const el = this.canvas()?.nativeElement;
      this.benchTrails(); this.liveTrail(); this.scrubT(); this.readout();
      if (el) this.draw(el);
    });
  }

  protected onRefChange(value: 'boss' | number): void {
    this.selector.set(value === 'boss' ? { kind: 'boss' } : { kind: 'enemy', gameId: value });
  }

  protected onScrub(value: number): void { this.pause(); this.scrubT.set(value); }

  protected togglePlay(): void {
    if (this.playing()) this.pause();
    else this.play();
  }

  private play(): void {
    if (this.scrubT() >= this.windowEnd() - 1e-6) this.scrubT.set(this.windowStart());
    this.playing.set(true);
    this.stopTimer();
    this.lastFrameMs = 0;
    // Drive playback off requestAnimationFrame: it aligns redraws to the display refresh and pauses
    // when the tab is hidden. The scrubber advances by real elapsed wall-time, so speed stays ~1x
    // independent of frame rate.
    const step = (nowMs: number): void => {
      const dt = this.lastFrameMs ? Math.min((nowMs - this.lastFrameMs) / 1000, MAX_FRAME_DT_S) : 0;
      this.lastFrameMs = nowMs;
      const next = this.scrubT() + dt;
      this.scrubT.set(next >= this.windowEnd() ? this.windowStart() : next);
      this.rafId = requestAnimationFrame(step);
    };
    this.rafId = requestAnimationFrame(step);
  }

  protected pause(): void {
    this.playing.set(false);
    this.stopTimer();
  }

  private stopTimer(): void {
    if (this.rafId != null) { cancelAnimationFrame(this.rafId); this.rafId = null; }
  }

  private livePlayerAt(t: number): RelPos | null {
    const live = this.live();
    const refId = this.liveRefId();
    if (!live || refId == null) return null;
    const ref = positionAt(live.timelines.get(refId), t);
    const player = positionAt(live.timelines.get(live.playerId), t);
    if (!ref || !player) return null;
    if (ref.mapID != null && player.mapID != null && ref.mapID !== player.mapID) return null;
    return toReferenceLocal(player, ref, t);
  }

  private draw(canvas: HTMLCanvasElement): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = globalThis.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || 600;
    const cssH = canvas.clientHeight || 420;
    // Only resize the backing buffer when it changed: assigning width/height reallocates + clears it,
    // wasted work every frame during playback. setTransform + clearRect below still run each frame.
    const bufW = Math.round(cssW * dpr);
    const bufH = Math.round(cssH * dpr);
    if (canvas.width !== bufW || canvas.height !== bufH) {
      canvas.width = bufW;
      canvas.height = bufH;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const cx = cssW / 2, cy = cssH / 2;
    const radiusPx = Math.min(cssW, cssH) / 2 - 28;

    const benchTrails = this.benchTrails();
    const liveTrail = this.liveTrail();
    const read = this.readout();

    let maxYd = 10;
    for (const trail of benchTrails) for (const point of trail) maxYd = Math.max(maxYd, point.dist);
    for (const point of liveTrail) maxYd = Math.max(maxYd, point.dist);
    maxYd = Math.ceil(maxYd / 5) * 5 + 5;
    const scale = radiusPx / maxYd;
    const toScreen = (point: { fwd: number; right: number }): [number, number] => [cx + point.right * scale, cy - point.fwd * scale];

    // The canvas draws imperatively and cannot consume `var(--token)`, so design tokens are resolved
    // to concrete values here. No hardcoded fallbacks - a missing token is a styles.scss bug.
    const css = getComputedStyle(canvas);
    const token = (name: string): string => css.getPropertyValue(name).trim();
    const gold = token('--gold');
    const border = token('--border');
    const muted = token('--muted');
    const enemyColor = token('--critical');
    const rankedColor = token('--accent');
    const outline = token('--map-dot-outline');

    ctx.strokeStyle = border; ctx.fillStyle = muted; ctx.font = '11px system-ui, sans-serif'; ctx.lineWidth = 1;
    for (let yd = 5; yd <= maxYd; yd += 5) {
      ctx.beginPath(); ctx.arc(cx, cy, yd * scale, 0, 2 * Math.PI); ctx.stroke();
      ctx.fillText(`${yd}y`, cx + 3, cy - yd * scale + 12);
    }

    // Reference at centre, facing up.
    ctx.fillStyle = enemyColor;
    ctx.beginPath(); ctx.moveTo(cx, cy - 9); ctx.lineTo(cx - 7, cy + 6); ctx.lineTo(cx + 7, cy + 6); ctx.closePath(); ctx.fill();

    // Benchmark: faint top-parse trails + their current dots.
    const t = this.scrubT();
    ctx.strokeStyle = muted; ctx.globalAlpha = 0.25; ctx.lineWidth = 1.5;
    for (const trail of benchTrails) {
      ctx.beginPath();
      trail.forEach((point, index) => { const [x, y] = toScreen(point); if (index) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    const benchNow = parsePointsAt(this.parseTimelines(), t);
    ctx.fillStyle = muted;
    for (const point of benchNow) { const [x, y] = toScreen(point); ctx.beginPath(); ctx.arc(x, y, 3, 0, 2 * Math.PI); ctx.fill(); }
    if (read?.centroid) {
      const [x, y] = toScreen(read.centroid);
      ctx.strokeStyle = rankedColor; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, 7, 0, 2 * Math.PI); ctx.stroke();
    }

    // Live player trail across the window.
    if (liveTrail.length) {
      ctx.strokeStyle = gold; ctx.globalAlpha = 0.5; ctx.lineWidth = 2;
      ctx.beginPath();
      liveTrail.forEach((point, index) => { const [x, y] = toScreen(point); if (index) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
      ctx.stroke(); ctx.globalAlpha = 1;
    }
    // Live player current position at the scrubbed moment.
    if (read?.player) {
      const [x, y] = toScreen(read.player);
      const r = 5;
      ctx.fillStyle = gold;
      ctx.beginPath(); ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = outline; ctx.lineWidth = 1; ctx.stroke();
    }
  }
}
