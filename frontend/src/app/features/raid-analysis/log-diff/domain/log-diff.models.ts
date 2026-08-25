import { WclFight, WclPlayer, WclReport } from '../../../../core/wcl/wcl.models';
import { RenderableLoadError } from '../../../../shared/components/load-state/load-state';
import { AbilityDiffRow } from './ability-diff-service';
import { TargetDiffRow } from './target-diff-service';

export type Side = 'A' | 'B';

export interface SideState {
  code: string;
  title: string;
  /** Kept so a detailed compare never re-fetches the report just to rebuild a BenchParse for this side. */
  report: WclReport | null;
  fights: WclFight[];
  players: WclPlayer[];
  selectedFightId: number | null;
  selectedPlayerId: number | null;
  loading: boolean;
  error: RenderableLoadError | null;
  /** A soft, non-error message: invalid input or a report with no boss pulls. */
  notice: string;
}

export interface ComparisonView {
  playerA: string;
  playerB: string;
  totalDpsA: number;
  totalDpsB: number;
  rows: AbilityDiffRow[];
  targetRows: TargetDiffRow[];
}
