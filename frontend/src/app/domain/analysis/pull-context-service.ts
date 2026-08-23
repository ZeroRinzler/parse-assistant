import { inject, Injectable } from '@angular/core';
import { WclApiService } from '../../core/wcl/wcl-api-service';
import { WclFight, WclReport } from '../../core/wcl/wcl.models';
import { Result, Results } from '../../core/http/result';
import { HttpLoadErrors } from '../../core/http/http-load-error';
import { LoggerService } from '../../core/observability/logger-service';
import { WclProjectionsService } from './wcl-projections-service';

@Injectable({ providedIn: 'root' })
export class PullContextService {
  private readonly logger = inject(LoggerService);
  private readonly projections = inject(WclProjectionsService);

  async analyzePull<TView>(
    wclApi: WclApiService, pull: PullRef, slice: PullAnalysis<TView>,
  ): Promise<Result<TView>> {
    const { reportCode, fightId } = pull;
    try {
      const report = await wclApi.getReport(reportCode);
      const fight = report.fights.find(entry => entry.id === fightId);
      // A selected fight may legitimately not be in the report yet during a live sync: not a failure.
      if (!fight) return Results.ok(slice.emptyView());
      return Results.ok(await slice.analyze({ report, fight, fightDurationS: this.projections.relativeS(fight.endTime, fight.startTime) }));
    } catch (cause) {
      this.logger.logWarn(`${slice.logSource} ${reportCode}:${fightId}`, cause);
      return HttpLoadErrors.toLoadError(cause, slice.errorId);
    }
  }
}

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
