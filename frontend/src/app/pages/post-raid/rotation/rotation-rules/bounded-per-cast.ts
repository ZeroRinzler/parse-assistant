import { round } from '../../../../shared/analysis/analysis-math';
import { AnalysisFinding, FindingOccurrence } from '../../../../core/models/analysis.models';
import { RuleSeverity } from '../../../../core/models/rulebook.models';
import {
  RuleBand, RuleJudging, Scale,
  bandLimits, exceedsTolerance, outOfBand, sampleOccurrences,
} from './engine-core';

/** Shared by every per-cast kind so they cannot drift apart in maths or in voice. */
export interface BoundedCasts {
  values: { timeS: number; value: number }[];
  scale: Scale;
  subject: string;
  /** Short noun phrase for the table row; `phrase` is the verb phrase the sentence needs, and `advice` the fix both share. */
  label: (limit: string) => string;
  phrase: (limit: string) => string;
  advice: (limit: string) => string;
  /** Names the mistake on the edge away from `primary`, for the kinds where overshooting is its own waste. */
  farLabel?: (limit: string) => string;
  farPhrase?: (limit: string) => string;
  farAdvice?: string;
}

interface Limits { near: number; far: number; }

interface Voice { label: string; phrase: string; advice: string; }

function nearVoice(judged: BoundedCasts, limits: Limits): Voice {
  const near = judged.scale.format(limits.near);
  return { label: judged.label(near), phrase: judged.phrase(near), advice: judged.advice(near) };
}

// A pull with both a near-side and a far-side violation keeps the primary phrasing (and its remedy) live, since the authored action still answers those casts.
function voiceFor(
  judged: BoundedCasts, judging: RuleJudging, limits: Limits, violations: { value: number }[],
): Voice {
  const { farPhrase, farAdvice, farLabel } = judged;
  if (!judging.twoSided || farPhrase == null || farAdvice == null || farLabel == null) {
    return nearVoice(judged, limits);
  }
  const allFar = violations.every(({ value }) =>
    judging.primary === 'below' ? value > limits.far : value < limits.far);
  if (!allFar) return nearVoice(judged, limits);
  const far = judged.scale.format(limits.far);
  return { label: farLabel(far), phrase: farPhrase(far), advice: farAdvice };
}

export function evaluateBoundedPerCast(
  judged: BoundedCasts, band: RuleBand, judging: RuleJudging, severity: RuleSeverity, remedy?: string,
): AnalysisFinding | null {
  if (!judged.values.length) return null;
  const { lo, hi } = bandLimits(judged.scale, band);
  const limits: Limits = judging.primary === 'below' ? { near: lo, far: hi } : { near: hi, far: lo };
  const violations = judged.values.filter(({ value }) => outOfBand(value, lo, hi, judging));
  if (!exceedsTolerance(violations.length, judged.values.length, band)) return null;
  const { label, phrase, advice } = voiceFor(judged, judging, limits, violations);
  const firstViolation = violations[0];
  if (firstViolation == null) return null;
  return {
    severity, category: 'rule_violation',
    timestamp_s: round(firstViolation.timeS, 3),
    label: `${judged.subject} ${label}`,
    message: `${violations.length} of ${judged.values.length} ${judged.subject} casts ${phrase}. ${advice}`,
    measured: { value: `${violations.length} / ${judged.values.length}`, unit: 'cast(s)' },
    details: remedy ? { remedy } : undefined,
    occurrences: sampleOccurrences(judged.values.map(({ timeS, value }): FindingOccurrence => {
      const label = judged.scale.format(value);
      return {
        atS: round(timeS, 3), ok: !outOfBand(value, lo, hi, judging), label,
        detail: `${judged.subject} cast at ${label}.`,
      };
    })),
    occurrenceTarget: judged.advice(judged.scale.format(limits.near)),
  };
}
