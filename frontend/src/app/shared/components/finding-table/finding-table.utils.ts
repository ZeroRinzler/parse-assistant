import { AnalysisFinding, FindingOccurrence, FindingTimeline } from '../../../core/models/analysis.models';
import { logWarn } from '../../../core/log';

export const UNKNOWN_COOLDOWN_LABEL = 'Unknown cooldown';

const UNKNOWN_COOLDOWN_CONTEXT = 'finding-table.unknown-cooldown';

const CAT_LABEL: Record<string, string> = {
  lost_cooldown: 'lost cast',
  cooldown_delay: 'held',
  cooldown_alignment: 'BL miss',
  cast_efficiency: 'downtime',
  hold_suggestion: 'hold',
};

interface FindingMeasure {
  value: string;
  unit?: string;
}

/** One row of the flat finding table; rule rows carry a plain `what` label, cooldown rows carry a spell identity. */
export interface FindingRow {
  severity: 'critical' | 'warning' | 'info';
  name?: string;
  spellId?: number | null;
  /** Baked icon filename for `wl-game-icon` (empty string when there is no art). */
  icon: string;
  timestampS?: number | null;
  chip?: string;
  what?: string;
  measured: FindingMeasure;
  fix?: string;
  /** Empty renders the row with no expand chevron. */
  occurrences: FindingOccurrence[];
  occurrenceTarget?: string;
  timeline?: FindingTimeline;
}

export interface OnPlanChip {
  name: string;
  spellId: number | null;
  /** Baked icon filename for `wl-game-icon` (empty string when there is no art). */
  icon: string;
}

export interface FindingEntry {
  name: string;
  spellId: number | null;
  /** Baked icon filename for `wl-game-icon` (empty string when there is no art). */
  icon: string;
  hasIssue: boolean;
  findings: AnalysisFinding[];
}

export function rowsFromEntries(entries: FindingEntry[]): FindingRow[] {
  const rows: FindingRow[] = [];
  for (const entry of entries) {
    if (!entry.hasIssue) continue;
    for (const f of entry.findings) {
      rows.push({
        severity: f.severity === 'critical' ? 'critical' : f.severity === 'info' ? 'info' : 'warning',
        name: entry.name,
        spellId: entry.spellId,
        icon: entry.icon,
        timestampS: f.timestamp_s ?? null,
        chip: CAT_LABEL[f.category],
        measured: f.measured ?? { value: '-' },
        fix: f.details?.remedy,
        occurrences: f.occurrences,
      });
    }
  }
  return rows;
}

export function onPlanFromEntries(entries: FindingEntry[]): OnPlanChip[] {
  return entries.filter(e => !e.hasIssue).map(e => ({ name: e.name, spellId: e.spellId, icon: e.icon }));
}

interface FindingBucket { issues: AnalysisFinding[]; holds: AnalysisFinding[]; }

export interface BucketOptions {
  spellId: (name: string) => number | null;
  icon: (name: string) => string;
}

type FindingBuckets = Record<string, FindingBucket>;

function bucketOf(byName: FindingBuckets, name: string): FindingBucket {
  return (byName[name] ??= { issues: [], holds: [] });
}

function bucketIssue(byName: FindingBuckets, finding: AnalysisFinding): void {
  if (finding.category === 'hold_suggestion' && finding.details?.cd_name) {
    bucketOf(byName, finding.details.cd_name).holds.push(finding);
  } else if (finding.cd_name) {
    bucketOf(byName, finding.cd_name).issues.push(finding);
  } else {
    // Surface a nameless finding under an explicit label so the coaching feedback is never dropped.
    logWarn(UNKNOWN_COOLDOWN_CONTEXT, finding);
    bucketOf(byName, UNKNOWN_COOLDOWN_LABEL).issues.push(finding);
  }
}

export function bucketFindings(
  findings: AnalysisFinding[],
  options: BucketOptions,
): FindingEntry[] {
  const byName: FindingBuckets = {};

  for (const finding of findings) {
    if (finding.severity !== 'success') bucketIssue(byName, finding);
  }
  for (const finding of findings) {
    if (finding.severity !== 'success') continue;
    const name = finding.cd_name;
    // The empty bucket is what surfaces the cooldown as an "On plan" chip.
    if (name) bucketOf(byName, name);
  }

  return Object.entries(byName).map(([name, bucket]) => ({
    name,
    spellId: options.spellId(name),
    icon: options.icon(name),
    hasIssue: bucket.issues.length > 0 || bucket.holds.length > 0,
    findings: [...bucket.issues, ...bucket.holds],
  }));
}
