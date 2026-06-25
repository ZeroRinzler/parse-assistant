import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { GameIconComponent } from '../game-icon/game-icon';
import { FormatDamagePipe } from '../../pipes/format-damage-pipe';
import { RangeRow } from '../range-chart/range-chart';

/** Severity state a row can be in; the template maps it to a badge-* class. */
export type RowStatus = 'success' | 'warning' | 'critical' | 'muted';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-compact-ability-row',
  imports: [GameIconComponent, FormatDamagePipe],
  templateUrl: './compact-ability-row.html',
})
export class CompactAbilityRowComponent {
  readonly row = input.required<RangeRow>();
  readonly higherIsBetter = input<boolean>(true);
  readonly showCasts = input<boolean>(true);
  readonly hidePlayer = input<boolean>(false);

  // Absolute gap = player damage - top average. Positive = ahead of top parses.
  private readonly gap = computed<number | null>(() => {
    const { playerPct, topAvg } = this.row();
    if (playerPct == null || topAvg == null) return null;
    return playerPct - topAvg;
  });

  protected readonly gapSign = computed(() => (this.gap() ?? 0) >= 0 ? '+' : '-');
  protected readonly gapMagnitude = computed(() => Math.abs(this.gap() ?? 0));

  // Semantic severity state only - the template maps it to a badge-* class.
  protected readonly gapStatus = computed<RowStatus>(() => {
    const { playerPct, topAvg } = this.row();
    if (playerPct == null) return 'critical';
    const gap = this.gap();
    if (gap == null || topAvg == null || topAvg === 0) return 'muted';
    // Direction-aware: burst wants gap >= 0; defensives want gap <= 0 (less taken).
    const signed = this.higherIsBetter() ? gap : -gap;
    if (signed >= 0) return 'success';
    if (Math.abs(gap) <= topAvg * 0.1) return 'warning';
    return 'critical';
  });

  protected readonly castsStatus = computed<RowStatus>(() => {
    const { playerCasts, topCasts } = this.row();
    if (topCasts == null) return 'muted';
    const player = playerCasts ?? 0;
    if (player >= topCasts) return 'success';
    if (topCasts - player <= 1) return 'warning';
    return 'critical';
  });
}
