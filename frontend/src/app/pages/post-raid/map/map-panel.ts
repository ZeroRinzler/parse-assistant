import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { FlyoverPanelComponent } from '../../../shared/components/flyover-panel/flyover-panel';
import { MapFeatureService } from './map.service';
import { MapCanvasComponent } from './map-canvas';

/**
 * Host for the positioning map, composed from the shared `wl-flyover-panel` shell. A
 * feature component - it injects exactly one service (`MapFeatureService`) and renders the
 * canvas when the panel is open. The page renders this once and wires other cards'
 * `openMap` outputs into `MapFeatureService.openAt`.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-map-panel',
  imports: [FlyoverPanelComponent, MapCanvasComponent],
  templateUrl: './map-panel.html',
})
export class MapPanelComponent {
  protected readonly map = inject(MapFeatureService);
}
