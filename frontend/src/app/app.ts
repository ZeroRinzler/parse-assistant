import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { PageNavComponent } from './shared/components/page-nav/page-nav';
import { PositioningPanelComponent } from './shared/components/positioning-panel/positioning-panel';
import { PositioningPanelService } from './core/services/positioning-panel';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-root',
  imports: [RouterOutlet, PageNavComponent, PositioningPanelComponent],
  templateUrl: './app.html',
  host: { class: 'block' },
})
export class App {
  protected readonly panel = inject(PositioningPanelService);
}
