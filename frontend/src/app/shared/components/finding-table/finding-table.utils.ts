import { AnalysisFinding } from '../../../core/models/analysis.models';

/** Maps a finding category to the short label shown as a meta chip. */
export const CAT_LABEL: Record<string, string> = {
  lost_cooldown: 'lost cast',
  cooldown_delay: 'held',
  cooldown_alignment: 'BL miss',
  cast_efficiency: 'downtime',
  hold_suggestion: 'hold tip',
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
  severity: 'critical' | 'warning';
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
        severity: f.severity === 'critical' ? 'critical' : 'warning',
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
  /**
   * When set, findings with category `rule_violation` or no `cd_name` are peeled
   * off into the returned `ruleFindings` instead of being bucketed (offensive view).
   */
  collectRules?: boolean;
}

/**
 * Group findings by cooldown/defensive name into `FindingEntry[]`. Optionally
 * collects rotation-rule findings separately (offensive analysis only).
 */
export function bucketFindings(
  findings: AnalysisFinding[],
  options: BucketOptions,
): { entries: FindingEntry[]; ruleFindings: AnalysisFinding[] } {
  const byName: Record<string, FindingBucket> = {};
  const ruleFindings: AnalysisFinding[] = [];

  for (const finding of findings) {
    if (finding.severity === 'success') continue;
    if (finding.category === 'hold_suggestion' && finding.details?.cd_name) {
      const name = finding.details.cd_name;
      (byName[name] ??= { issues: [], holds: [] }).holds.push(finding);
    } else if (options.collectRules && (finding.category === 'rule_violation' || !finding.cd_name)) {
      ruleFindings.push(finding);
    } else {
      const name = finding.cd_name;
      if (!name) continue;
      (byName[name] ??= { issues: [], holds: [] }).issues.push(finding);
    }
  }
  for (const finding of findings) {
    if (finding.severity !== 'success') continue;
    const name = finding.cd_name;
    if (name) (byName[name] ??= { issues: [], holds: [] }).success = finding;
  }

  const entries = Object.entries(byName).map(([name, bucket]) => {
    const hasCritical = bucket.issues.some(f => f.severity === 'critical');
    const hasIssue = bucket.issues.length > 0 || bucket.holds.length > 0;
    const metaItems: string[] = [];
    for (const finding of bucket.issues) {
      const label = CAT_LABEL[finding.category];
      if (label && !metaItems.includes(label)) metaItems.push(label);
    }
    if (bucket.holds.length) metaItems.push(`${bucket.holds.length} hold tip${bucket.holds.length > 1 ? 's' : ''}`);
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

  return { entries, ruleFindings };
}
