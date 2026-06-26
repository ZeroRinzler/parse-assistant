/**
 * View-model data shapes for the window-comparison + range-chart leaves.
 *
 * Kept in core/models (not in the component files) so feature/transform services can
 * import them as plain models without reaching into a UI component.
 */

/** One ability comparison row: player value vs the top-parse min/avg/max range. */
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

export type WindowStatus = 'good' | 'warn' | 'bad' | 'muted' | 'info';

export interface ComparisonWindow {
  timeStartS: number;
  timeEndS: number;
  spellIds: number[];
  labels: string[];
  status: WindowStatus;
  statusIcon: string;
  overview: RangeRow;
  detailRows: RangeRow[];
}
