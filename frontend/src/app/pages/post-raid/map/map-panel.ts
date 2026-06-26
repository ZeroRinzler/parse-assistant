import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { map } from 'rxjs';
import { BreakpointObserver } from '@angular/cdk/layout';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MapFeatureService } from './map.service';
import { MapCanvasComponent } from './map-canvas';

/**
 * Host for the positioning map: a right-side drawer on desktop, a full-screen
 * sheet on mobile. A feature component - it injects exactly one service
 * (`MapFeatureService`) and renders the canvas when the panel is open. Replaces
 * the global `PositioningPanelComponent`; the page renders this once and wires
 * other cards' `openMap` outputs into `MapFeatureService.openAt`.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-map-panel',
  imports: [MatButtonModule, MatIconModule, MapCanvasComponent],
  templateUrl: './map-panel.html',
})
export class MapPanelComponent {
  protected readonly map = inject(MapFeatureService);
  private readonly breakpoints = inject(BreakpointObserver);

  protected readonly isMobile = toSignal(
    this.breakpoints.observe('(max-width: 768px)').pipe(map(result => result.matches)),
    { initialValue: false },
  );
}
