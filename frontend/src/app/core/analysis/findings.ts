/**
 * Finding severity helpers shared across the analysis modules.
 */
import { AnalysisFinding } from '../models/analysis.models';

export type Severity = AnalysisFinding['severity'];

const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
  hold_suggestion: 2,
  success: 3,
};

/** Sort findings in place: critical first, success last. Stable for equal ranks. */
export function sortBySeverity(findings: AnalysisFinding[]): void {
  findings.sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 4) - (SEVERITY_ORDER[b.severity] ?? 4));
}
