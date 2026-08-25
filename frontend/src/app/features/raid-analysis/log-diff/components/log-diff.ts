import { ChangeDetectionStrategy, Component, inject, output } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { LogDiffFeatureService } from '../facade/log-diff-feature-service';
import { ReportPicker } from './report-picker';
import { AbilityDiffTable } from './ability-diff-table';
import { TargetDiffTable } from './target-diff-table';

/** Composes the two report pickers and the diff tables; the page shell mounts this with no inputs. */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-log-diff',
  imports: [MatButtonModule, ReportPicker, AbilityDiffTable, TargetDiffTable],
  templateUrl: './log-diff.html',
  host: { class: 'block' },
})
export class LogDiff {
  protected readonly service = inject(LogDiffFeatureService);

  protected readonly sideA = this.service.sideA;
  protected readonly sideB = this.service.sideB;
  protected readonly playersA = this.service.visibleA;
  protected readonly playersB = this.service.visibleB;
  protected readonly comparing = this.service.comparing;
  protected readonly canCompare = this.service.canCompare;
  protected readonly comparisonValue = this.service.comparisonValue;
  protected readonly comparisonError = this.service.comparisonError;

  /** Fires on every Compare click, so a page hosting this slice can react (e.g. load a cross-slice detailed view). */
  readonly compared = output();

  protected onUrlSubmit(side: 'A' | 'B', url: string): void {
    void this.service.loadSide(side, url);
  }

  protected onFightChange(side: 'A' | 'B', fightId: number): void {
    this.service.selectFight(side, fightId);
  }

  protected onPlayerChange(side: 'A' | 'B', playerId: number): void {
    this.service.selectPlayer(side, playerId);
  }

  protected onCompare(): void {
    void this.service.compare();
    this.compared.emit();
  }
}
