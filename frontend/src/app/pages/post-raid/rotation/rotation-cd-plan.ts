import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { GameIconComponent } from '../../../shared/components/game-icon/game-icon';
import { CollapsibleTextComponent } from '../../../shared/components/collapsible-text/collapsible-text';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state';
import { FormatDurationPipe } from '../../../shared/pipes/format-duration-pipe';
import { loadResource } from '../../../shared/state/load-resource';
import { RotationFeatureService, CdPlanRow } from './rotation.service';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-rotation-cd-plan',
  imports: [DecimalPipe, GameIconComponent, CollapsibleTextComponent, LoadStateComponent, FormatDurationPipe],
  templateUrl: './rotation-cd-plan.html',
})
export class RotationCdPlanComponent {
  private readonly rotation = inject(RotationFeatureService);

  readonly spec = input.required<string>();
  readonly encounterId = input.required<number>();

  protected readonly title = 'Cooldown plan';
  protected readonly subtitle = 'Offensive cooldown usage across top parses.';

  readonly busyChange = output<boolean>();
  readonly availableChange = output<boolean>();

  private readonly load = loadResource({
    params: () => ({ spec: this.spec(), encounterId: this.encounterId() }),
    load: ({ spec, encounterId }) => this.rotation.loadPlanView(spec, encounterId),
    context: 'rotation.loadPlanView',
    initialAvailable: true,
    busyChange: this.busyChange,
    availableChange: this.availableChange,
  });

  protected readonly available = this.load.available;
  protected readonly error = this.load.error;
  protected readonly items = computed<CdPlanRow[]>(() => this.load.value()?.rows ?? []);
}
