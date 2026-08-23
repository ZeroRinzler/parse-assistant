import { Injectable } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class SpecReportService {

  private formatAge(ageS: number): string {
    const age = Math.floor(Math.max(0, ageS));
    if (age >= DAY_S) return AGE.format(-Math.floor(age / DAY_S), 'day');
    if (age >= HOUR_S) return AGE.format(-Math.floor(age / HOUR_S), 'hour');
    if (age >= MINUTE_S) return AGE.format(-Math.floor(age / MINUTE_S), 'minute');
    return AGE.format(-age, 'second');
  }

  // Keyed on the checked count, not on a null stamp: this is the exact condition that sorts a spec first.
  private noteCell(row: SpecReportRow): string {
    if (row.checkedCount === 0) return NEVER_CHECKED;
    return row.emptyCount > 0 ? `${row.emptyCount} empty` : '';
  }

  private ageCell(row: SpecReportRow, nowS: number): string {
    if (row.checkedCount === 0) return '';
    return row.ingestedAtS != null ? this.formatAge(nowS - row.ingestedAtS) : UNKNOWN;
  }

  formatSpecReport(rows: readonly SpecReportRow[], nowS: number): string {
    const cells = rows.map(row => ({
      marker: row.selected ? SELECTED_MARKER : ' ',
      spec: row.spec,
      version: row.version != null ? `v${row.version}` : '',
      age: this.ageCell(row, nowS),
      note: this.noteCell(row),
    }));
    const specWidth = Math.max(0, ...cells.map(cell => cell.spec.length));
    const versionWidth = Math.max(0, ...cells.map(cell => cell.version.length));
    const ageWidth = Math.max(0, ...cells.map(cell => cell.age.length));
    return cells
      .map(cell => `${cell.marker} ${cell.spec.padEnd(specWidth)}  ${cell.version.padEnd(versionWidth)}  ${cell.age.padStart(ageWidth)}  ${cell.note}`.trimEnd())
      .join('\n');
  }
}

export interface SpecReportRow {
  spec: string;
  version: number | null;
  ingestedAtS: number | null;
  checkedCount: number;
  emptyCount: number;
  selected: boolean;
}

export const SELECTED_MARKER = '*';
const NEVER_CHECKED = 'never checked';
const UNKNOWN = '?';

const MINUTE_S = 60;
const HOUR_S = 60 * MINUTE_S;
const DAY_S = 24 * HOUR_S;

// Fixed locale: the log reads the same whoever runs it.
const AGE = new Intl.RelativeTimeFormat('en', { numeric: 'always', style: 'narrow' });
