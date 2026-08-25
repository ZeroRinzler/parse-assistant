import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { WclFight } from '../../../../core/wcl/wcl.models';
import { LogDiffFeatureService } from '../../log-diff/facade/log-diff-feature-service';
import { DetailedCompareFeatureService } from './detailed-compare-feature-service';
import { LogDiff } from '../../log-diff/components/log-diff';
import { PullOverview } from '../../pull-overview/components/pull-overview';
import { Rotation } from '../../rotation/components/rotation';
import { BurstWindows } from '../../burst-windows/components/burst-windows';
import { Defensive } from '../../defensive/components/defensive';
import { Talents } from '../../talents/components/talents';
import { Stats } from '../../stats/components/stats';
import { Gear } from '../../gear/components/gear';

/** Page shell: composes the log-diff slice plus (same spec only) the full Analyze card set - "them" standing in for the top-parse bench. */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-compare',
  imports: [LogDiff, PullOverview, Rotation, BurstWindows, Defensive, Talents, Stats, Gear],
  templateUrl: './compare.html',
})
export class Compare {
  private readonly logDiff = inject(LogDiffFeatureService);
  protected readonly detailed = inject(DetailedCompareFeatureService);

  protected readonly sideA = this.logDiff.sideA;
  protected readonly sideB = this.logDiff.sideB;

  protected readonly fightA = computed<WclFight | undefined>(() =>
    this.sideA().fights.find(f => f.id === this.sideA().selectedFightId));
  protected readonly fightB = computed<WclFight | undefined>(() =>
    this.sideB().fights.find(f => f.id === this.sideB().selectedFightId));

  // Fed to every card as the comparison-target label, so "vs top parses" reads as "vs <peer's name>" instead.
  protected readonly peerLabel = computed(() =>
    this.sideB().players.find(p => p.id === this.sideB().selectedPlayerId)?.name ?? 'Log B');
  // Fed to the burst card in place of the generic "You", so its buff comparison names both sides.
  protected readonly youLabel = computed(() =>
    this.sideA().players.find(p => p.id === this.sideA().selectedPlayerId)?.name ?? 'You');

  protected onCompared(): void {
    void this.detailed.loadDetailed();
  }
}
