import { round } from '../../../../../domain/analysis/analysis-math';
import { AnalysisFinding, FindingOccurrence } from '../../../../../domain/analysis/analysis.models';
import { RuleCondition, RuleSeverity } from '../../../../../domain/rulebook/rulebook.models';
import { RuleBand, RuleJudging, RuleKind } from './rule-kind';

/** Shared by both filler kinds so the two can only differ in their gate. */
export interface FillerSplit {
  coached: number;
  total: number;
  /** Where the replay opens, so the finding points at the first cast that should have been the coached one. */
  firstAlternativeS: number | null;
}

export abstract class FillerKind<C extends RuleCondition> extends RuleKind<C> {
  protected splitFillers(
    coachedId: number, alternativeIds: number[], castTimesS: (spellId: number) => number[],
  ): FillerSplit {
    const coached = castTimesS(coachedId).length;
    const alternatives = alternativeIds.flatMap(castTimesS);
    return {
      coached,
      total: coached + alternatives.length,
      firstAlternativeS: alternatives.length ? Math.min(...alternatives) : null,
    };
  }

  /** Share of the filler choice the coached spell won, or null when the pull never filled under that gate. */
  protected fillerShare(split: FillerSplit): number | null {
    return split.total ? split.coached / split.total : null;
  }

  protected fillerFinding(
    split: FillerSplit, band: RuleBand, judging: RuleJudging, severity: RuleSeverity,
    spellName: string, where: string, remedy?: string,
  ): AnalysisFinding | null {
    const { lo, hi } = this.bandLimits(this.PERCENT, band);
    const share = this.fillerShare(split);
    if (share == null || !this.outOfBand(share, lo, hi, judging)) return null;
    return {
      severity, category: 'rule_violation',
      timestamp_s: split.firstAlternativeS == null ? undefined : round(split.firstAlternativeS, 3),
      label: `${spellName} ${where}`,
      message: `${spellName} was only ${this.PERCENT.format(share)} of your fillers ${where}. Aim for ${this.PERCENT.format(lo)} or more.`,
      measured: { value: `${Math.round(share * 100)} / ${Math.round(lo * 100)}`, unit: '% of fillers' },
      details: remedy ? { remedy } : undefined,
      occurrences: [],
    };
  }

  /** Shared by both filler kinds so their chip logic cannot drift apart. */
  protected fillerOccurrences(
    coachedId: number, coachedName: string, alternativeIds: number[], alternativeNames: string[],
    timesFor: (spellId: number) => number[],
  ): FindingOccurrence[] {
    const entries: { atS: number; ok: boolean; label: string }[] = [
      ...timesFor(coachedId).map(time => ({ atS: round(time, 3), ok: true, label: coachedName })),
      ...alternativeIds.flatMap((spellId, i) => {
        const name = alternativeNames[i] ?? String(spellId);
        return timesFor(spellId).map(time => ({ atS: round(time, 3), ok: false, label: name }));
      }),
    ];
    entries.sort((a, b) => a.atS - b.atS);
    return this.sampleOccurrences(entries.map(entry => ({
      ...entry,
      detail: entry.ok
        ? `${entry.label} was the coached filler here.`
        : `${entry.label} was pressed instead of ${coachedName} here.`,
    })));
  }
}
