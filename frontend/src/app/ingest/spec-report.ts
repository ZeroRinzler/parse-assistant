export interface SpecReportRow {
  spec: string;
  version: number | null;
  ingestedAtS: number | null;
  selected: boolean;
}

export const SELECTED_MARKER = '*';
const UNKNOWN = '?';

const MINUTE_S = 60;
const HOUR_S = 60 * MINUTE_S;
const DAY_S = 24 * HOUR_S;

// Fixed locale: the log reads the same whoever runs it.
const AGE = new Intl.RelativeTimeFormat('en', { numeric: 'always', style: 'narrow' });

export function formatAge(ageS: number): string {
  const age = Math.floor(Math.max(0, ageS));
  if (age >= DAY_S) return AGE.format(-Math.floor(age / DAY_S), 'day');
  if (age >= HOUR_S) return AGE.format(-Math.floor(age / HOUR_S), 'hour');
  if (age >= MINUTE_S) return AGE.format(-Math.floor(age / MINUTE_S), 'minute');
  return AGE.format(-age, 'second');
}

export function formatSpecReport(rows: readonly SpecReportRow[], nowS: number): string {
  const cells = rows.map(row => ({
    marker: row.selected ? SELECTED_MARKER : ' ',
    spec: row.spec,
    version: `v${row.version ?? UNKNOWN}`,
    age: row.ingestedAtS != null ? formatAge(nowS - row.ingestedAtS) : UNKNOWN,
  }));
  const specWidth = Math.max(0, ...cells.map(cell => cell.spec.length));
  const versionWidth = Math.max(0, ...cells.map(cell => cell.version.length));
  return cells
    .map(cell => `${cell.marker} ${cell.spec.padEnd(specWidth)}  ${cell.version.padEnd(versionWidth)}  ${cell.age}`)
    .join('\n');
}
