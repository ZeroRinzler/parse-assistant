import { Component, OnChanges, input, inject } from '@angular/core';
import { NgApexchartsModule, ApexChart, ApexDataLabels, ApexTooltip, ApexPlotOptions, ApexXAxis, ApexYAxis, ApexFill, ApexGrid } from 'ng-apexcharts';
import { IconCacheService } from '../../../core/services/icon-cache';

export interface RangeRow {
  spellId?: number;
  label: string;
  playerPct: number | null;
  topAvg: number;
  topMin: number;
  topMax: number;
}

@Component({
  selector: 'wl-range-chart',
  imports: [NgApexchartsModule],
  template: `
    <apx-chart
      [series]="series"
      [chart]="chartOpts"
      [plotOptions]="plotOpts"
      [dataLabels]="dataLabels"
      [tooltip]="tooltip"
      [xaxis]="xaxis"
      [yaxis]="yaxis"
      [fill]="fill"
      [grid]="grid">
    </apx-chart>
  `,
})
export class RangeChartComponent implements OnChanges {
  private readonly icons = inject(IconCacheService);

  readonly rows = input.required<RangeRow[]>();
  readonly unit = input<'pct' | 'raw'>('pct');
  readonly higherIsBetter = input<boolean>(true);

  protected series: { name: string; data: { x: string; y: number[] }[]; color?: string }[] = [];

  protected chartOpts: ApexChart = {
    type: 'rangeBar',
    height: 0,
    toolbar: { show: false },
    animations: { enabled: false },
    background: 'transparent',
    foreColor: '#ccc',
  };

  protected plotOpts: ApexPlotOptions = {
    bar: { horizontal: true, rangeBarGroupRows: false, barHeight: '60%' },
  };

  protected dataLabels: ApexDataLabels = { enabled: false };

  protected tooltip: ApexTooltip = {
    custom: ({ seriesIndex, dataPointIndex, w }) => {
      const row = this.rows()[dataPointIndex];
      if (!row) return '';
      const fmt = (v: number | null) => v == null ? '—' : this.unit() === 'pct' ? (v * 100).toFixed(1) + '%' : String(v);
      const name = row.spellId ? (this.icons.get(row.spellId)?.name || row.label) : row.label;
      return `<div style="padding:8px;font-size:12px">
        <b>${name}</b><br>
        You: ${fmt(row.playerPct)}<br>
        Top avg: ${fmt(row.topAvg)} (${fmt(row.topMin)}–${fmt(row.topMax)})
      </div>`;
    },
  };

  protected xaxis: ApexXAxis = {
    type: 'numeric',
    min: 0,
    labels: {
      formatter: (val) => this.unit() === 'pct' ? (Number(val) * 100).toFixed(0) + '%' : String(val),
      style: { colors: '#aaa', fontSize: '11px' },
    },
    axisBorder: { show: false },
    axisTicks: { show: false },
  };

  protected yaxis: ApexYAxis = {
    labels: { style: { colors: '#aaa', fontSize: '11px' }, maxWidth: 120 },
  };

  protected fill: ApexFill = {
    type: 'solid',
    opacity: [0.9, 0.4, 0.9],
  };

  protected grid: ApexGrid = {
    borderColor: '#333',
    xaxis: { lines: { show: true } },
    yaxis: { lines: { show: false } },
  };

  ngOnChanges(): void {
    const r = this.rows();
    const cats = r.map(row => row.spellId ? (this.icons.get(row.spellId)?.name || row.label) : row.label);

    const topRangeSeries = r.map((row, i) => ({
      x: cats[i], y: [row.topMin, row.topMax],
    }));
    const topAvgSeries = r.map((row, i) => ({
      x: cats[i], y: [row.topAvg, row.topAvg + (row.topMax - row.topMin) * 0.02],
    }));
    const playerSeries = r.map((row, i) => {
      const v = row.playerPct ?? 0;
      return { x: cats[i], y: [0, v] };
    });

    this.series = [
      { name: 'Top range', data: topRangeSeries, color: '#4a9eff' },
      { name: 'Top avg', data: topAvgSeries, color: '#60cfff' },
      { name: 'You', data: playerSeries, color: '#ff9f43' },
    ];

    this.chartOpts = {
      ...this.chartOpts,
      height: Math.max(80, r.length * 52 + 20),
    };
  }
}
