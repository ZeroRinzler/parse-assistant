import { ChangeDetectionStrategy, Component, effect, inject, input, output, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { GameIconComponent } from '../../../shared/components/game-icon/game-icon';
import { CollapsibleTextComponent } from '../../../shared/components/collapsible-text/collapsible-text';
import { LoadStateComponent, RenderableLoadError } from '../../../shared/components/load-state/load-state';
import { FormatDurationPipe } from '../../../shared/pipes/format-duration-pipe';
import { LatestLoad } from '../../../shared/latest-load';
import { logWarn } from '../../../core/log';
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
  readonly title = input('Cooldown plan');
  readonly subtitle = input('Offensive cooldown usage across top parses.');

  readonly busyChange = output<boolean>();
  readonly availableChange = output<boolean>();

  protected readonly available = signal(true);
  protected readonly error = signal<RenderableLoadError | null>(null);
  protected readonly items = signal<CdPlanRow[]>([]);

  private readonly loader = new LatestLoad();

  constructor() {
    effect(() => {
      const spec = this.spec();
      const encounterId = this.encounterId();
      this.loader.run(this.rotation.loadPlanView(spec, encounterId), {
        context: 'rotation.loadPlanView',
        apply: result => {
          if (result.ok) {
            this.error.set(null);
            this.available.set(true);
            this.availableChange.emit(true);
            this.items.set(result.value.rows);
          } else {
            if (result.error.kind === 'permanent') logWarn(result.error.id, result.error.context);
            this.error.set(result.error.kind === 'missing' ? null : result.error);
            this.available.set(false);
            this.availableChange.emit(false);
            this.items.set([]);
          }
        },
        settled: () => this.busyChange.emit(false),
      });
    });
  }
}
