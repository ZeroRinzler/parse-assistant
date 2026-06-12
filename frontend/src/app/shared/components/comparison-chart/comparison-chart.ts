import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

export interface ChartRow {
  labelHtml: string;
  playerVal: number | null;
  topAvg?: number | null;
  topMin?: number | null;
  topMax?: number | null;
  highlight?: boolean;
}

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-comparison-chart',
  imports: [],
  templateUrl: './comparison-chart.html',
  styleUrl: './comparison-chart.scss',
})
export class ComparisonChartComponent {
  readonly rows = input.required<ChartRow[]>();
  readonly higherIsBetter = input<boolean>(true);
  readonly unit = input<'pct' | 'k'>('pct');
  readonly maxVal = input<number | null>(null);
  readonly noDataText = input<string>('Re-ingest parses to compare with top 10');

  protected readonly hasTopData = computed(() => this.rows().some(r => r.topAvg != null));

  protected readonly computedMaxVal = computed(() => {
    if (this.maxVal() != null) return this.maxVal()!;
    const allVals = this.rows().flatMap(r => [r.playerVal, r.topAvg, r.topMax].filter((v): v is number => v != null));
    return Math.max(...allVals, 0.001);
  });

  protected computedRows = computed(() => {
    const maxV = this.computedMaxVal();
    const higherBetter = this.higherIsBetter();
    return this.rows().map(r => {
      const pPct = r.playerVal != null ? Math.min(r.playerVal / maxV * 100, 100) : null;
      const tPct = r.topAvg != null ? Math.min(r.topAvg / maxV * 100, 100) : null;
      const tMinP = r.topMin != null ? Math.min(r.topMin / maxV * 100, 100) : null;
      const tMaxP = r.topMax != null ? Math.min(r.topMax / maxV * 100, 100) : null;

      let dCls = '';
      if (r.playerVal != null && r.topAvg != null) {
        const lo = r.topMin ?? r.topAvg * 0.8;
        const hi = r.topMax ?? r.topAvg * 1.2;
        if (higherBetter) dCls = r.playerVal >= r.topAvg ? 'delta-good' : r.playerVal >= lo ? 'delta-warn' : 'delta-bad';
        else dCls = r.playerVal <= r.topAvg ? 'delta-good' : r.playerVal <= hi ? 'delta-warn' : 'delta-bad';
      }

      let candleLeft = 0, candleWidth = 0, candleTickPct = 50;
      if (tMinP != null && tMaxP != null && tMaxP > tMinP) {
        candleLeft = tMinP;
        candleWidth = tMaxP - tMinP;
        candleTickPct = tPct != null ? Math.min(((tPct - tMinP) / candleWidth) * 100, 100) : 50;
      }

      return {
        ...r,
        pPct, tPct, tMinP, tMaxP,
        dCls, candleLeft, candleWidth, candleTickPct,
        fmtPlayer: this._fmt(r.playerVal),
        fmtTop: this._fmt(r.topAvg),
        fmtTopMin: this._fmt(r.topMin),
        fmtTopMax: this._fmt(r.topMax),
      };
    });
  });

  private _fmt(v: number | null | undefined): string {
    if (v == null) return '-';
    return this.unit() === 'pct' ? (v * 100).toFixed(1) + '%' : this._formatNumber(v);
  }

  private _formatNumber(n: number): string {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
    return String(n);
  }
}
