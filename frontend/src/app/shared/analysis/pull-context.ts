import { WclApiService } from '../../core/services/wcl-api';
import { WclFight, WclReport } from '../../core/models/wcl.models';
import { logWarn } from '../../core/log';
import { Result, ok } from '../../core/result';
import { toLoadError } from '../../core/transport/http-load-error';
import { relativeS } from './wcl-projections';

export interface PullContext {
  report: WclReport;
  fight: WclFight;
  fightDurationS: number;
}

export interface PullRef {
  reportCode: string;
  fightId: number;
}

interface PullAnalysis<TView> {
  logSource: string;
  errorId: string;
  emptyView: () => TView;
  analyze: (context: PullContext) => Promise<TView>;
}

export async function analyzePull<TView>(
  wclApi: WclApiService, pull: PullRef, slice: PullAnalysis<TView>,
): Promise<Result<TView>> {
  const { reportCode, fightId } = pull;
  try {
    const report = await wclApi.getReport(reportCode);
    const fight = report.fights.find(entry => entry.id === fightId);
    // A selected fight may legitimately not be in the report yet during a live sync: not a failure.
    if (!fight) return ok(slice.emptyView());
    return ok(await slice.analyze({ report, fight, fightDurationS: relativeS(fight.endTime, fight.startTime) }));
  } catch (cause) {
    logWarn(`${slice.logSource} ${reportCode}:${fightId}`, cause);
    return toLoadError(cause, slice.errorId);
  }
}
