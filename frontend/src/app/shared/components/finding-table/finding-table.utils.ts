import { AnalysisFinding } from '../../../core/models/analysis.models';
import { logWarn } from '../../../core/log';

/** Displayed "What" label for a finding whose cooldown could not be identified (no cd_name). */
export const UNKNOWN_COOLDOWN_LABEL = 'Unknown cooldown';

/** logWarn context for a surfaced finding that carries no identifiable cooldown. */
const UNKNOWN_COOLDOWN_CONTEXT = 'finding-table.unknown-cooldown';

/** Maps a finding category to the short label shown as a meta chip. */
export const CAT_LABEL: Record<string, string> = {
  lost_cooldown: 'lost cast',
  cooldown_delay: 'held',
  cooldown_alignment: 'BL miss',
  cast_efficiency: 'downtime',
  hold_suggestion: 'hold',
};

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
  severity: 'critical' | 'warning' | 'info';
  name?: string;
  spellId?: number | null;
  /** Baked icon filename for `wl-game-icon` (empty string when there is no art). */
  icon: string;
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
  /** Baked icon filename for `wl-game-icon` (empty string when there is no art). */
  icon: string;
}

/** One collapsed spell entry: a cooldown / defensive and the findings it gathered. */
export interface FindingEntry {
  name: string;
  spellId: number | null;
  /** Baked icon filename for `wl-game-icon` (empty string when there is no art). */
  icon: string;
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
        severity: f.severity === 'critical' ? 'critical' : f.severity === 'info' ? 'info' : 'warning',
        name: entry.name,
        spellId: entry.spellId,
        icon: entry.icon,
        timestampMs: f.timestamp_ms ?? null,
        chip: catLabel[f.category],
        measured: f.measured ?? { value: '-' },
        fix: f.details?.remedy,
      });
    }
  }
  return rows;
}

/** Cooldowns without any issue become "on plan" chips. */
export function onPlanFromEntries(entries: FindingEntry[]): OnPlanChip[] {
  return entries.filter(e => !e.hasIssue).map(e => ({ name: e.name, spellId: e.spellId, icon: e.icon }));
}

/** Grouping of a cooldown/defensive's findings before they collapse into a `FindingEntry`. */
interface FindingBucket { issues: AnalysisFinding[]; holds: AnalysisFinding[]; success?: AnalysisFinding; }

export interface BucketOptions {
  /** Resolves a cooldown/defensive name to its spell id for icon rendering. */
  spellId: (name: string) => number | null;
  /** Resolves a cooldown/defensive name to its baked icon filename (empty when none). */
  icon: (name: string) => string;
}

/** Group findings by cooldown/defensive name into `FindingEntry[]`. */
export function bucketFindings(
  findings: AnalysisFinding[],
  options: BucketOptions,
): FindingEntry[] {
  const byName: Record<string, FindingBucket> = {};

  for (const finding of findings) {
    if (finding.severity === 'success') continue;
    if (finding.category === 'hold_suggestion' && finding.details?.cd_name) {
      const name = finding.details.cd_name;
      (byName[name] ??= { issues: [], holds: [] }).holds.push(finding);
    } else if (finding.cd_name) {
      (byName[finding.cd_name] ??= { issues: [], holds: [] }).issues.push(finding);
    } else {
      // Surface a nameless finding under an explicit label so the coaching feedback is never
      // dropped, and log it so a report can reproduce it.
      logWarn(UNKNOWN_COOLDOWN_CONTEXT, finding);
      (byName[UNKNOWN_COOLDOWN_LABEL] ??= { issues: [], holds: [] }).issues.push(finding);
    }
  }
  for (const finding of findings) {
    if (finding.severity !== 'success') continue;
    const name = finding.cd_name;
    if (name) (byName[name] ??= { issues: [], holds: [] }).success = finding;
  }

  return Object.entries(byName).map(([name, bucket]) => {
    const hasCritical = bucket.issues.some(f => f.severity === 'critical');
    const hasIssue = bucket.issues.length > 0 || bucket.holds.length > 0;
    const metaItems: string[] = [];
    for (const finding of bucket.issues) {
      const label = CAT_LABEL[finding.category];
      if (label && !metaItems.includes(label)) metaItems.push(label);
    }
    if (bucket.holds.length) metaItems.push(`${bucket.holds.length} hold${bucket.holds.length > 1 ? 's' : ''}`);
    return {
      name,
      spellId: options.spellId(name),
      icon: options.icon(name),
      hasCritical,
      hasIssue,
      metaItems,
      findings: [...bucket.issues, ...bucket.holds],
    };
  });
}
