import { ChangeDetectionStrategy, Component, computed, input, linkedSignal, output } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { GameIcon } from '../game-icon/game-icon';
import { CompactAbilityRow } from '../compact-ability-row/compact-ability-row';
import { FormatDurationPipe } from '../../pipes/format-duration-pipe';
import { FormatDamagePipe } from '../../pipes/format-damage-pipe';
import { SignedPercentPipe } from '../../pipes/signed-percent-pipe';
import type { RangeRow, ComparisonWindow, WindowSpell } from '../../../domain/analysis/window-comparison.models';

/** One row of the buff/consumable comparison block: a label plus whether each side had it up. */
interface BuffRow {
  label: string;
  /** Set only for a recommended major cooldown row, to render its game icon like the chips above. */
  spellId?: number;
  icon?: string;
  you: boolean;
  peer: boolean;
}

type TimelineCell =
  | { readonly kind: 'window'; readonly index: number; readonly window: ComparisonWindow }
  | { readonly kind: 'gap'; readonly id: string };

// Distinguishes option ids when several comparison cards share a page (burst + defensive).
let nextInstanceSeq = 0;

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-window-comparison',
  // Angular custom elements default to display:inline; block keeps the card full-width.
  host: { class: 'block' },
  imports: [MatIconModule, MatButtonModule, GameIcon, CompactAbilityRow, FormatDurationPipe, FormatDamagePipe, SignedPercentPipe],
  templateUrl: './window-comparison.html',
})
export class WindowComparison {
  readonly windows = input.required<ComparisonWindow[]>();
  readonly higherIsBetter = input<boolean>(true);
  readonly showMap = input<boolean>(false);
  readonly showClip = input<boolean>(false);
  // Casts column is meaningful for burst (offensive) windows only; hidden for defensives.
  readonly showCasts = input<boolean>(true);
  // Burst hides this: its own buff/cooldown comparison block below replaces it with a clearer per-side view.
  readonly showRecommendedCooldowns = input<boolean>(true);
  readonly heading = input<string>('');
  readonly subtitle = input<string>('');
  /** Set only by the compare page: the other log's player name, in place of "top" everywhere this card names the comparison side. */
  readonly peerLabel = input<string | null>(null);
  /** Set only by the compare page: the analyzed player's own name, in place of the generic "You". */
  readonly youLabel = input<string | null>(null);
  readonly openMap = output<number>();
  readonly openClip = output<number>();

  protected readonly vsAverageLabel = computed(() => this.peerLabel() ? `vs ${this.peerLabel()}` : 'vs top average');
  protected readonly rangeHeading = computed(() => this.peerLabel() ? `Damage vs ${this.peerLabel()}` : 'Damage vs top range');
  protected readonly avgColumnLabel = computed(() => this.peerLabel() ?? 'top avg');
  protected readonly youDisplayLabel = computed(() => this.youLabel() ?? 'You');

  // Each dashed pacing slot stands for this many seconds of pause; a sub-slot pause is 0 slots and longer lulls add proportionally more.
  private static readonly GAP_SLOT_SECONDS = 20;

  protected readonly selectedIndex = computed(() => {
    const windows = this.windows();
    const higherIsBetter = this.higherIsBetter();
    let worst = 0;
    let worstRatio = higherIsBetter ? Infinity : -Infinity;
    windows.forEach((w, i) => {
      if (w.status === 'muted') return;
      const player = w.overview.playerPct;
      const top = w.overview.topAvg;
      if (player == null || !top || top <= 0) return;
      const ratio = player / top;
      if (higherIsBetter ? ratio < worstRatio : ratio > worstRatio) {
        worstRatio = ratio;
        worst = i;
      }
    });
    return worst;
  });

  // The instance is reused across encounter switches on /pre, so manual state cannot outlive its windows set.
  private readonly _manualIndex = linkedSignal<ComparisonWindow[], number | null>({
    source: this.windows,
    computation: () => null,
  });

  protected readonly activeIndex = computed(() =>
    this._manualIndex() ?? this.selectedIndex());

  protected readonly activeWindow = computed(() =>
    this.windows()[this.activeIndex()] ?? null);

  private readonly instanceId = `wl-window-comparison-${nextInstanceSeq++}`;

  protected optionId(index: number): string {
    return `${this.instanceId}-opt-${index}`;
  }

  // The listbox keeps focus; aria-activedescendant points screen readers at the active chip.
  protected readonly activeOptionId = computed(() => this.optionId(this.activeIndex()));

  // Flat sequence of chips interleaved with dashed pacing slots so the template renders one row without measuring time.
  protected readonly timelineCells = computed<TimelineCell[]>(() => {
    const cells: TimelineCell[] = [];
    let prev: { window: ComparisonWindow; index: number } | undefined;
    this.windows().forEach((window, index) => {
      if (prev) {
        const slots = this.gapSlots(window.timeStartS - prev.window.timeEndS);
        for (let s = 0; s < slots; s++) cells.push({ kind: 'gap', id: `${prev.index}-${s}` });
      }
      cells.push({ kind: 'window', index, window });
      prev = { window, index };
    });
    return cells;
  });

  private gapSlots(pauseS: number): number {
    return Math.max(0, Math.floor(pauseS / WindowComparison.GAP_SLOT_SECONDS));
  }

  protected select(i: number): void {
    this._manualIndex.set(i);
  }

  protected onKeydown(event: KeyboardEvent): void {
    const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!delta) return;
    event.preventDefault();
    const next = this.activeIndex() + delta;
    if (next >= 0 && next < this.windows().length) this.select(next);
  }

  // 'info' (bench-only, pre-fight) has no player overlay, so it hides the absent player columns/delta like a muted window.
  protected readonly activeIsMuted = computed(() => {
    const status = this.activeWindow()?.status;
    return status === 'muted' || status === 'info';
  });

  // Bench-only (pre-fight) window has no player overlay, so the You/Top bar is hidden and the header shows top-parse damage instead.
  protected readonly activeIsBenchOnly = computed(() => this.activeWindow()?.status === 'info');

  // Sorted by absolute gap so the biggest loss surfaces first; direction-aware since burst wants player >= top but defensives want player <= top.
  protected readonly activeDetailRows = computed<RangeRow[]>(() => {
    const rows = this.activeWindow()?.detailRows ?? [];
    const higherIsBetter = this.higherIsBetter();
    const loss = (row: RangeRow): number => {
      // No player value (an unreached window's breakdown): the loss is the whole top-parse damage.
      if (row.playerPct == null) return -(row.topAvg ?? 0);
      const gap = row.playerPct - (row.topAvg ?? 0);
      return higherIsBetter ? gap : -gap; // negative = worse
    };
    return [...rows].sort((a, b) => loss(a) - loss(b));
  });

  protected readonly overviewMax = computed(() => {
    // Filter NaN as well as null: a single NaN would make Math.max return NaN and blank the bar.
    const vals = this.windows().flatMap(w =>
      [w.overview.topAvg, w.overview.topMax, w.overview.playerPct]
        .filter((v): v is number => v != null && Number.isFinite(v)));
    return Math.max(...vals, 0.01);
  });

  private barPct(value: number, max: number): number {
    const pct = (value / max) * 100;
    return Number.isFinite(pct) ? Math.min(100, Math.max(0, pct)) : 0;
  }

  protected readonly overviewDelta = computed<number | null>(() => {
    const w = this.activeWindow();
    if (!w) return null;
    const { playerPct, topAvg } = w.overview;
    if (playerPct == null || topAvg == null || topAvg === 0) return null;
    const delta = ((playerPct - topAvg) / topAvg) * 100;
    // A NaN player/top value would otherwise render a "NaN%" badge; drop it to the muted state.
    return Number.isFinite(delta) ? delta : null;
  });

  // The raw (non-percent) gap behind overviewDelta, for the peer bullet chart's "-2.2M" readout.
  protected readonly overviewDeltaAbs = computed<number | null>(() => {
    const w = this.activeWindow();
    if (!w) return null;
    const { playerPct, topAvg } = w.overview;
    if (playerPct == null || topAvg == null) return null;
    return playerPct - topAvg;
  });

  protected readonly overviewDeltaStatus = computed<'muted' | 'better' | 'worse'>(() => {
    const delta = this.overviewDelta();
    if (delta == null) return 'muted';
    const isBetter = this.higherIsBetter() ? delta >= 0 : delta <= 0;
    return isBetter ? 'better' : 'worse';
  });

  // Overview bar geometry as plain percentages, bound via [style.left.%]/[style.width.%] in the template.
  protected readonly overviewPlayerWidthPct = computed<number | null>(() => {
    const w = this.activeWindow();
    if (w?.overview.playerPct == null) return null;
    return this.barPct(w.overview.playerPct, this.overviewMax());
  });

  protected readonly overviewRangeLeftPct = computed<number | null>(() => {
    const w = this.activeWindow();
    if (w?.overview.topMin == null || w.overview.topMax == null) return null;
    return this.barPct(w.overview.topMin, this.overviewMax());
  });

  protected readonly overviewRangeWidthPct = computed<number | null>(() => {
    const w = this.activeWindow();
    if (w?.overview.topMin == null || w.overview.topMax == null) return null;
    const max = this.overviewMax();
    return Math.max(0, this.barPct(w.overview.topMax, max) - this.barPct(w.overview.topMin, max));
  });

  protected readonly overviewAvgLeftPct = computed<number | null>(() => {
    const w = this.activeWindow();
    if (w?.overview.topAvg == null) return null;
    return this.barPct(w.overview.topAvg, this.overviewMax());
  });

  // The full-fight set (deduped), so the same cooldown rows appear under every window, not just the ones it recommends itself.
  protected readonly fightCooldowns = computed<WindowSpell[]>(() => {
    const seen = new Map<number, WindowSpell>();
    for (const w of this.windows()) for (const spell of w.spells) if (!seen.has(spell.id)) seen.set(spell.id, spell);
    return [...seen.values()];
  });

  protected readonly buffRows = computed<BuffRow[]>(() => {
    const buffs = this.activeWindow()?.buffs;
    if (!buffs) return [];
    const { player, peer } = buffs;
    const rows: BuffRow[] = [
      { label: 'Potion', you: player.potion, peer: peer.potion },
      { label: 'Power Infusion', you: player.powerInfusion, peer: peer.powerInfusion },
      { label: 'Bloodlust', you: player.bloodlust, peer: peer.bloodlust },
    ];
    for (const spell of this.fightCooldowns()) {
      rows.push({
        label: spell.name, spellId: spell.id, icon: spell.icon,
        you: player.cooldowns[spell.id] ?? false, peer: peer.cooldowns[spell.id] ?? false,
      });
    }
    return rows;
  });
}
