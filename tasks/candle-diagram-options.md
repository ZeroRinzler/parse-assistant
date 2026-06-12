# Candle Diagram Library Options

The current `wl-range-chart` component uses **ng-apexcharts** `rangeBar` to visualize
per-ability damage breakdown: a shaded range (min–max across top parses), an average tick, and the player's value.

The rendering is currently suboptimal — ApexCharts' rangeBar overlays three separate series
that don't cleanly represent "candlestick + player bar". Below are four alternative approaches.

---

## Option 1: Custom SVG (no library)

**Package**: none (pure Angular + SVG)

**What it looks like**:
```
Spell A  |====|----[###]----|----|   player: 12%
Spell B       |---[##]---|            player: 8%
              ↑           ↑
            topMin      topMax
                 ↑
               topAvg (tick mark)
              ████ = player bar
```

**Pros**:
- Full control over layout, colors, sizing
- Zero bundle overhead
- Exact pixel-level match to the design
- No ApexCharts animation flicker
- Accessible (aria labels on `<rect>` elements)

**Cons**:
- ~80–100 lines of SVG math you own/maintain
- No built-in tooltips (need to implement with Angular CDK overlay or title attributes)

**How to implement**:
Replace `<apx-chart>` with an inline SVG template. Each row gets:
- A `<rect>` for the top-parse range (min→max, e.g. `fill: #4a9eff; opacity: 0.25`)
- A `<line>` for the average tick
- A `<rect>` for the player bar (e.g. `fill: #ff9f43; opacity: 0.85`)
- A `<text>` label on the left

This is the **recommended option** — avoids the library entirely, gives a cleaner look, and is faster.

---

## Option 2: Chart.js floating bars (ng2-charts)

**Package**: `chart.js@4`, `ng2-charts@6`

```bash
npm install chart.js ng2-charts
```

**What it can do**:
Chart.js supports "floating bars" in bar charts: each data point is `[min, max]` instead of a single value.
This natively renders a range bar. You can stack a second dataset for the player value.

**Pros**:
- Mature, widely used library
- Floating bars are a first-class feature (no tricks with multiple series)
- Good default theming and animations

**Cons**:
- `ng2-charts` v6 adds ~180 kB to the bundle (Chart.js is large)
- Aligning "average tick" inside the floating bar still requires a custom plugin
- Horizontal bar orientation requires `indexAxis: 'y'`

**Example config**:
```typescript
datasets: [
  { label: 'Top range', data: rows.map(r => [r.topMin, r.topMax]), backgroundColor: '#4a9eff44' },
  { label: 'You', data: rows.map(r => [0, r.playerPct ?? 0]), backgroundColor: '#ff9f43cc' },
]
```

---

## Option 3: ECharts (ngx-echarts)

**Package**: `echarts@5`, `ngx-echarts@18`

```bash
npm install echarts ngx-echarts
```

**What it can do**:
ECharts has a native `candlestick` series (OHLC chart) and a `custom` series type for fully custom
rendering with `renderItem`. The custom series gives pixel-level control inside the ECharts coordinate system.

**Pros**:
- Very rich built-in chart types
- `custom` series = arbitrary SVG/canvas with access to the coordinate system
- Better performance than ApexCharts for large datasets

**Cons**:
- ~500 kB bundle (echarts full build); tree-shakeable but imports still add ~200 kB
- `ngx-echarts` configuration is verbose
- The candlestick series is OHLC (Open/High/Low/Close), not min/avg/max — needs mapping

**Candlestick mapping** (OHLC → range):
- Open = topMin, High = topAvg, Low = topAvg, Close = topMax

---

## Option 4: Inline progress bars (no chart library)

**Package**: none

This is not a "candle" diagram but a simpler alternative that may communicate the same info better in context.

**What it looks like**:
```
Shadow Blades   You ████████░░   8.2%
                Top ░░░████░░░   6.1%–11.3% (avg 8.8%)
```

**Pros**:
- Extremely simple, no math
- Works great in card/table layouts
- No library, no bundle cost
- Matches the existing `cmp-fill` / `cmp-candle` pattern already used in `defensives-section.html`

**Cons**:
- Not a real "candle" — range is shown as a shaded region on a bar, not a box-and-whisker
- Less precise visually for narrow ranges

**Note**: The `defensives-section.html` already uses this pattern with `.cmp-track`, `.cmp-fill`, `.cmp-candle`, and `.cmp-candle-tick` CSS classes. The `RangeChartComponent` (ApexCharts) was added to replace these in the expanded detail view, but the simpler bars actually read better at small sizes.

---

## Recommendation

| Option | Bundle cost | Visual quality | Effort |
|---|---|---|---|
| Custom SVG | 0 kB | ★★★★★ | Medium (80–100 lines) |
| Inline progress bars | 0 kB | ★★★ | Low (already done in defensives-section) |
| Chart.js (ng2-charts) | +180 kB | ★★★★ | Low-Medium |
| ECharts (ngx-echarts) | +200 kB | ★★★★★ | High |

**Best path**: Replace `RangeChartComponent` (and the `ng-apexcharts` dependency entirely) with a custom SVG component. The SVG approach gives the cleanest output, zero bundle overhead, and full control. The implementation is straightforward — see the horizontal bar math already present in `burst-windows.scss`.
