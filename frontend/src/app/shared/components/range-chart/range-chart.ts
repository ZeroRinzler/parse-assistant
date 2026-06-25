import { ChangeDetectionStrategy, Component, ElementRef, OnChanges, OnDestroy, AfterViewInit, input, inject, viewChild, computed } from '@angular/core';
import {
  Chart,
  BarController,
  BarElement,
  CategoryScale,
  LinearScale,
  Tooltip,
  Plugin,
  ChartConfiguration,
} from 'chart.js';
import { IconCacheService } from '../../../core/services/icon-cache';

Chart.register(BarController, BarElement, CategoryScale, LinearScale, Tooltip);

export interface RangeRow {
  spellId?: number;
  label: string;
  playerPct: number | null;
  // Top-parse range. All three may be null when no comparison data exists for a row.
  topAvg: number | null;
  topMin: number | null;
  topMax: number | null;
  // Cast counts for the sorted-impact table (burst windows only). Null when unavailable.
  playerCasts?: number | null;
  topCasts?: number | null;
}

interface OverlayPoint {
  avg: number | null;
  player: number | null;
}

// The canvas/Chart.js draw imperatively and cannot consume `var(--token)`, so the
// shared design tokens (the same ones the SVG legend uses) are resolved to concrete
// values once per render and the values are passed in. This is the only bridge
// between the CSS token source of truth and the chart.
interface ChartColors {
  range: string;
  rangeFill: string;
  grid: string;
  tick: string;
  avg: string;
  you: string;
  dotOutline: string;
}

// Stashed on the Chart instance so the overlay plugin reads geometry + pre-resolved
// colors instead of touching the DOM on every frame.
interface OverlayState {
  points: OverlayPoint[];
  colors: Pick<ChartColors, 'avg' | 'you' | 'dotOutline'>;
}

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-range-chart',
  template: `
    @if (showLegend()) {
      <div class="flex gap-4 text-[11px] text-[var(--muted)] mb-1.5">
        <span class="inline-flex items-center gap-1.5">
          <span class="inline-block w-3 h-3 rounded-[2px] bg-[var(--chart-range-fill)] border border-[var(--chart-range)]"></span>Top range
        </span>
        <span class="inline-flex items-center gap-1.5">
          <span class="inline-block w-[3px] h-3 bg-[var(--chart-avg)]"></span>Top average
        </span>
        <span class="inline-flex items-center gap-1.5">
          <span class="inline-block w-3 h-3 rounded-full bg-[var(--chart-you)]"></span>You
        </span>
      </div>
    }
    <div class="relative w-full" [style.height.px]="height()">
      <canvas #canvas></canvas>
    </div>
  `,
})
export class RangeChartComponent implements AfterViewInit, OnChanges, OnDestroy {
  private readonly icons = inject(IconCacheService);
  private readonly host = inject(ElementRef<HTMLElement>);

  // Resolve the design tokens (defined on `html` in styles.scss) the canvas needs.
  // Done once per render; custom properties inherit, so the host element sees them.
  private resolveColors(): ChartColors {
    const css = getComputedStyle(this.host.nativeElement);
    const token = (name: string): string => css.getPropertyValue(name).trim();
    return {
      range: token('--chart-range'),
      rangeFill: token('--chart-range-fill'),
      grid: token('--border'),
      tick: token('--muted'),
      avg: token('--chart-avg'),
      you: token('--chart-you'),
      dotOutline: token('--chart-dot-outline'),
    };
  }

  readonly rows = input.required<RangeRow[]>();
  readonly unit = input<'pct' | 'raw'>('pct');
  readonly higherIsBetter = input<boolean>(true);
  // Fix the x-axis maximum so multiple charts (e.g. per-window cards) share a scale.
  readonly maxVal = input<number | null>(null);
  // Show the built-in "Top range / Top average / You" legend.
  readonly showLegend = input<boolean>(true);
  // Show the category (y-axis) tick labels. Disable for single-row charts where
  // the surrounding card already provides context.
  readonly showLabels = input<boolean>(true);
  // Vertical space per row, in px.
  readonly rowHeight = input<number>(52);

  private readonly canvasRef = viewChild<ElementRef<HTMLCanvasElement>>('canvas');
  private chart?: Chart;
  private viewReady = false;

  protected readonly height = computed(() =>
    Math.max(60, this.rows().length * this.rowHeight() + 28));

  private fmt(v: number | null): string {
    if (v == null) return '-';
    return this.unit() === 'pct' ? (v * 100).toFixed(1) + '%' : RangeChartComponent.compact(v);
  }

  // Abbreviate large raw damage values (e.g. 6_837_621 → "6.84M").
  private static compact(v: number): string {
    const a = Math.abs(v);
    if (a >= 1e9) return (v / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M';
    if (a >= 1e3) return (v / 1e3).toFixed(1) + 'K';
    return v.toFixed(0);
  }

  private label(row: RangeRow): string {
    return row.spellId ? (this.icons.get(row.spellId)?.name || row.label) : row.label;
  }

  // Draws the average tick and the player "You" dot on top of each range bar.
  // Positions are derived from the scales (not the bar element) so rows without
  // a top-parse range still place the player dot correctly.
  private readonly overlayPlugin: Plugin<'bar'> = {
    id: 'rangeOverlay',
    afterDatasetsDraw: (chart) => {
      const overlay = (chart as unknown as { _overlay?: OverlayState })._overlay;
      if (!overlay) return;
      const { points, colors } = overlay;
      const { ctx } = chart;
      const xScale = chart.scales['x'];
      const yScale = chart.scales['y'];
      const band = points.length > 0 ? (yScale.bottom - yScale.top) / points.length : 0;
      const thickness = Math.max(8, Math.min(18, band * 0.7));

      points.forEach((p, i) => {
        const y = yScale.getPixelForValue(i);
        if (!Number.isFinite(y)) return;

        ctx.save();
        // Average tick
        if (p.avg != null) {
          const ax = xScale.getPixelForValue(p.avg);
          ctx.strokeStyle = colors.avg;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(ax, y - thickness / 2);
          ctx.lineTo(ax, y + thickness / 2);
          ctx.stroke();
        }

        // Player "You" dot
        if (p.player != null) {
          const px = xScale.getPixelForValue(p.player);
          ctx.beginPath();
          ctx.arc(px, y, Math.min(thickness / 2, 6), 0, Math.PI * 2);
          ctx.fillStyle = colors.you;
          ctx.fill();
          ctx.lineWidth = 1.5;
          ctx.strokeStyle = colors.dotOutline;
          ctx.stroke();
        }
        ctx.restore();
      });
    },
  };

  ngAfterViewInit(): void {
    this.viewReady = true;
    this.render();
  }

  ngOnChanges(): void {
    if (this.viewReady) this.render();
  }

  ngOnDestroy(): void {
    this.chart?.destroy();
  }

  private render(): void {
    const canvas = this.canvasRef()?.nativeElement;
    if (!canvas) return;

    const rows = this.rows();
    const cats = rows.map(r => this.label(r));

    const colors = this.resolveColors();

    this.chart?.destroy();

    // Explicit axis max keeps independent charts comparable and ensures player
    // dots stay in view even when a row has no top-parse range bar.
    const axisMax = this.maxVal() ?? Math.max(
      0.001,
      ...rows.flatMap(r => [r.playerPct, r.topAvg, r.topMax].filter((v): v is number => v != null)),
    );

    const config: ChartConfiguration<'bar'> = {
      type: 'bar',
      data: {
        labels: cats,
        datasets: [{
          label: 'Top range',
          data: rows.map(r =>
            (r.topMin != null && r.topMax != null) ? [r.topMin, r.topMax] as [number, number] : null),
          backgroundColor: colors.rangeFill,
          borderColor: colors.range,
          borderWidth: 1,
          borderSkipped: false,
          borderRadius: 2,
          maxBarThickness: 18,
          barPercentage: 0.6,
          categoryPercentage: 0.85,
        }],
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        scales: {
          x: {
            min: 0,
            max: axisMax,
            grid: { color: colors.grid },
            ticks: {
              color: colors.tick,
              font: { size: 11 },
              callback: (val) => this.unit() === 'pct'
                ? (Number(val) * 100).toFixed(0) + '%'
                : RangeChartComponent.compact(Number(val)),
            },
          },
          y: {
            grid: { display: false },
            ticks: {
              display: this.showLabels(),
              color: colors.tick,
              font: { size: 11 },
            },
          },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            displayColors: false,
            callbacks: {
              title: (items) => items.length ? this.label(rows[items[0].dataIndex]) : '',
              label: () => '',
              afterBody: (items) => {
                if (!items.length) return [];
                const r = rows[items[0].dataIndex];
                const top = r.topAvg != null
                  ? `Top average: ${this.fmt(r.topAvg)} (${this.fmt(r.topMin)}-${this.fmt(r.topMax)})`
                  : 'Top average: -';
                return [`You: ${this.fmt(r.playerPct)}`, top];
              },
            },
          },
        },
      },
      plugins: [this.overlayPlugin],
    };

    this.chart = new Chart(canvas, config);
    (this.chart as unknown as { _overlay: OverlayState })._overlay = {
      points: rows.map(r => ({ avg: r.topAvg, player: r.playerPct })),
      colors: { avg: colors.avg, you: colors.you, dotOutline: colors.dotOutline },
    };
    this.chart.update();
  }
}
