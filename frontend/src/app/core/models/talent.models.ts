export interface TalentEntry {
  name: string;
  icon: string;
  /** Absent for hero-tree picks, which have no spell behind them. */
  spellId?: number;
}

export type SpecTalents = Record<string, TalentEntry>;

type TalentDiffKind = 'added' | 'dropped' | 'rank';

export interface TalentDiff {
  kind: TalentDiffKind;
  /** For `dropped`, the most common build's talent this one omits. */
  talent: TalentEntry;
  /** `rank` only: points this build spends, and what the most common build spends. */
  rank?: number;
  standardRank?: number;
}
