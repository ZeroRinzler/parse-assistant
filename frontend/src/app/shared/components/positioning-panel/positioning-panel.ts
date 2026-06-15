import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { map } from 'rxjs';
import { BreakpointObserver } from '@angular/cdk/layout';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { PositioningPanelService } from '../../../core/services/positioning-panel';
import { PositioningMapComponent } from '../positioning-map/positioning-map';

/**
 * Global host for the positioning map. A right-side drawer on desktop, a
 * full-screen sheet on mobile. Driven entirely by PositioningPanelService.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-positioning-panel',
  imports: [MatButtonModule, MatIconModule, PositioningMapComponent],
  templateUrl: './positioning-panel.html',
})
export class PositioningPanelComponent {
  protected readonly panel = inject(PositioningPanelService);
  private readonly breakpoints = inject(BreakpointObserver);

  protected readonly isMobile = toSignal(
    this.breakpoints.observe('(max-width: 768px)').pipe(map(r => r.matches)),
    { initialValue: false },
  );
}
