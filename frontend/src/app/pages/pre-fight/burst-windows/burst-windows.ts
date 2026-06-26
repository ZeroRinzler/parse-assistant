import { ChangeDetectionStrategy, Component, computed, inject, input, linkedSignal } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { BurstWindowVm } from '../pre-fight.vm';
import { GameIconComponent } from '../../../shared/components/game-icon/game-icon';
import { PositioningPanelService } from '../../../core/services/positioning-panel';
import { FormatDurationPipe } from '../../../shared/pipes/format-duration-pipe';
import { FormatDamagePipe } from '../../../shared/pipes/format-damage-pipe';

/**
 * Pre-fight burst-window overview: stat blocks, an interactive timeline rail and
 * a single selected-window panel (label, time range, stacked cooldowns, damage,
 * positioning button and a relative-size bar). Prep-level only - no per-ability
 * damage breakdown. Self-contained to /pre; does not reuse the analyze-page
 * window-comparison component.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-pre-burst-windows',
  imports: [MatIconModule, MatButtonModule, GameIconComponent, FormatDurationPipe, FormatDamagePipe],
  templateUrl: './burst-windows.html',
})
export class PreBurstWindowsComponent {
  private readonly panel = inject(PositioningPanelService);

  readonly windows = input.required<BurstWindowVm[]>();
  readonly avgDurationS = input<number>(0);

  /** Selected window index; resets to the first window whenever the list changes. */
  protected readonly sel = linkedSignal<BurstWindowVm[], number>({
    source: this.windows,
    computation: () => 0,
  });
  protected readonly selected = computed(() => this.windows()[this.sel()] ?? null);

  /** Five evenly spaced tick marks across the average kill time, in seconds. */
  protected readonly timeTicks = computed<number[]>(() => {
    const d = this.avgDurationS();
    return [0, 0.25, 0.5, 0.75, 1].map(f => f * d);
  });

  /** Position of a window's badge along the rail, as a percentage of kill time. */
  protected leftPct(bw: BurstWindowVm): number {
    const d = this.avgDurationS();
    return d > 0 ? Math.min(100, Math.max(0, (bw.startS / d) * 100)) : 0;
  }

  protected selectBurst(i: number): void {
    this.sel.set(i);
  }

  protected badgeClass(i: number): string {
    const base = 'absolute top-1/2 -translate-x-1/2 -translate-y-1/2 w-[26px] h-[26px] rounded-[6px] '
      + 'flex items-center justify-center box-border cursor-pointer transition-colors duration-150 p-0';
    return i === this.sel()
      ? `${base} bg-[var(--gold)] border-0 shadow-[0_0_0_2px_rgba(229,204,128,0.35)]`
      : `${base} bg-[var(--gold)]/[0.16] border border-[var(--gold)]/40`;
  }

  protected dotClass(i: number): string {
    const base = 'w-[7px] h-[7px] rounded-full';
    return i === this.sel()
      ? `${base} bg-[var(--bg)] opacity-90`
      : `${base} bg-[var(--gold)] opacity-75`;
  }

  /** Map is available once the page has loaded top-parse positions. */
  protected readonly showMap = computed(() => !!this.panel.positions());

  protected openMap(): void {
    const bw = this.selected();
    if (!bw) return;
    const label = bw.cds.map(c => c.name).join(', ') || 'Burst window';
    const spellIds = bw.cds.map(c => c.spellId).filter((id): id is number => id != null);
    this.panel.openAt(bw.startS, { kind: 'boss' }, label, spellIds);
  }
}
