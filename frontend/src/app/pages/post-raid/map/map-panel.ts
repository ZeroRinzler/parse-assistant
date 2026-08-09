import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { FlyoverPanelComponent } from '../../../shared/components/flyover-panel/flyover-panel';
import { MapFeatureService } from './map.service';
import { MapCanvasComponent } from './map-canvas';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-map-panel',
  imports: [FlyoverPanelComponent, MapCanvasComponent],
  templateUrl: './map-panel.html',
})
export class MapPanelComponent {
  protected readonly map = inject(MapFeatureService);
}
