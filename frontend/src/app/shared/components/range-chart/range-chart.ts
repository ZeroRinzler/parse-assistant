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
  topAvg: number;
  topMin: number;
  topMax: number;
}

// Colors (kept from the previous ApexCharts implementation)
const COLOR_RANGE = '#4a9eff';
const COLOR_RANGE_FILL = 'rgba(74, 158, 255, 0.28)';
const COLOR_AVG = '#60cfff';
const COLOR_YOU = '#ffd700'; // "You" value rendered as a yellow dot

interface OverlayPoint {
  avg: number;
  player: number | null;
}

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-range-chart',
  template: `
    <div class="rc-legend">
      <span class="rc-li"><span class="rc-sw range"></span>Top range</span>
      <span class="rc-li"><span class="rc-sw avg"></span>Top avg</span>
      <span class="rc-li"><span class="rc-sw you"></span>You</span>
    </div>
    <div class="rc-wrap" [style.height.px]="height()">
      <canvas #canvas></canvas>
    </div>
  `,
  styles: [`
    .rc-legend {
      display: flex;
      gap: 16px;
      font-size: 11px;
      color: #aaa;
      margin-bottom: 6px;
    }
    .rc-li { display: inline-flex; align-items: center; gap: 6px; }
    .rc-sw { width: 12px; height: 12px; border-radius: 2px; display: inline-block; }
    .rc-sw.range { background: ${COLOR_RANGE_FILL}; border: 1px solid ${COLOR_RANGE}; }
    .rc-sw.avg { width: 3px; height: 12px; border-radius: 0; background: ${COLOR_AVG}; }
    .rc-sw.you { border-radius: 50%; background: ${COLOR_YOU}; }
    .rc-wrap { position: relative; width: 100%; }
  `],
})
export class RangeChartComponent implements AfterViewInit, OnChanges, OnDestroy {
  private readonly icons = inject(IconCacheService);

  readonly rows = input.required<RangeRow[]>();
  readonly unit = input<'pct' | 'raw'>('pct');
  readonly higherIsBetter = input<boolean>(true);

  private readonly canvasRef = viewChild<ElementRef<HTMLCanvasElement>>('canvas');
  private chart?: Chart;
  private viewReady = false;

  protected readonly height = computed(() => Math.max(80, this.rows().length * 52 + 20));

  private fmt(v: number | null): string {
    if (v == null) return '—';
    return this.unit() === 'pct' ? (v * 100).toFixed(1) + '%' : String(v);
  }

  private label(row: RangeRow): string {
    return row.spellId ? (this.icons.get(row.spellId)?.name || row.label) : row.label;
  }

  // Draws the average tick and the player "You" dot on top of each range bar.
  private readonly overlayPlugin: Plugin<'bar'> = {
    id: 'rangeOverlay',
    afterDatasetsDraw: (chart) => {
      const points = (chart as unknown as { _overlay?: OverlayPoint[] })._overlay;
      if (!points) return;
      const { ctx } = chart;
      const xScale = chart.scales['x'];
      const meta = chart.getDatasetMeta(0);
      points.forEach((p, i) => {
        const bar = meta.data[i];
        if (!bar) return;
        const { y, height } = bar.getProps(['y', 'height'], true) as { y: number; height: number };
        const thickness = Math.max(8, height);

        // Average tick
        const ax = xScale.getPixelForValue(p.avg);
        ctx.save();
        ctx.strokeStyle = COLOR_AVG;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(ax, y - thickness / 2);
        ctx.lineTo(ax, y + thickness / 2);
        ctx.stroke();

        // Player "You" dot
        if (p.player != null) {
          const px = xScale.getPixelForValue(p.player);
          ctx.beginPath();
          ctx.arc(px, y, Math.min(thickness / 2, 6), 0, Math.PI * 2);
          ctx.fillStyle = COLOR_YOU;
          ctx.fill();
          ctx.lineWidth = 1.5;
          ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
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

    this.chart?.destroy();

    const config: ChartConfiguration<'bar'> = {
      type: 'bar',
      data: {
        labels: cats,
        datasets: [{
          label: 'Top range',
          data: rows.map(r => [r.topMin, r.topMax] as [number, number]),
          backgroundColor: COLOR_RANGE_FILL,
          borderColor: COLOR_RANGE,
          borderWidth: 1,
          borderSkipped: false,
          borderRadius: 2,
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
            grid: { color: '#333' },
            ticks: {
              color: '#aaa',
              font: { size: 11 },
              callback: (val) => this.unit() === 'pct'
                ? (Number(val) * 100).toFixed(0) + '%'
                : String(val),
            },
          },
          y: {
            grid: { display: false },
            ticks: { color: '#aaa', font: { size: 11 } },
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
                return [
                  `You: ${this.fmt(r.playerPct)}`,
                  `Top avg: ${this.fmt(r.topAvg)} (${this.fmt(r.topMin)}–${this.fmt(r.topMax)})`,
                ];
              },
            },
          },
        },
      },
      plugins: [this.overlayPlugin],
    };

    this.chart = new Chart(canvas, config);
    (this.chart as unknown as { _overlay: OverlayPoint[] })._overlay =
      rows.map(r => ({ avg: r.topAvg, player: r.playerPct }));
    this.chart.update();
  }
}
