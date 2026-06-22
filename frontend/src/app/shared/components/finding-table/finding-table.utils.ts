import { AnalysisFinding } from '../../../core/models/analysis.models';

/** The prominent "Measured" cell: a value over its unit (e.g. "1 / 15" + "cast(s)"). */
export interface FindingMeasure {
  value: string;
  unit?: string;
}

/**
 * One row of the flat finding table (severity · What · Measured · Fix).
 * Rule rows carry a plain `what` label; cooldown rows carry a spell identity.
 */
export interface FindingRow {
  severity: 'critical' | 'warning';
  name?: string;
  spellId?: number | null;
  timestampMs?: number | null;
  chip?: string;
  what?: string;
  measured: FindingMeasure;
  fix?: string;
}

/** A cooldown used on plan, shown as a compact success chip rather than a row. */
export interface OnPlanChip {
  name: string;
  spellId: number | null;
}

/** One collapsed spell entry: a cooldown / defensive and the findings it gathered. */
export interface FindingEntry {
  name: string;
  spellId: number | null;
  hasIssue: boolean;
  hasCritical: boolean;
  metaItems: string[];
  findings: AnalysisFinding[];
}

/** Flatten cooldown entries with issues into one table row per finding. */
export function rowsFromEntries(entries: FindingEntry[], catLabel: Record<string, string>): FindingRow[] {
  const rows: FindingRow[] = [];
  for (const entry of entries) {
    if (!entry.hasIssue) continue;
    for (const f of entry.findings) {
      rows.push({
        severity: f.severity === 'critical' ? 'critical' : 'warning',
        name: entry.name,
        spellId: entry.spellId,
        timestampMs: f.timestamp_ms ?? null,
        chip: catLabel[f.category],
        measured: f.measured!,
        fix: f.details?.remedy,
      });
    }
  }
  return rows;
}

/** Cooldowns without any issue become "on plan" chips. */
export function onPlanFromEntries(entries: FindingEntry[]): OnPlanChip[] {
  return entries.filter(e => !e.hasIssue).map(e => ({ name: e.name, spellId: e.spellId }));
}
