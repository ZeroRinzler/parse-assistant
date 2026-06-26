import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { PageNavComponent } from './shared/components/page-nav/page-nav';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-root',
  imports: [RouterOutlet, PageNavComponent],
  templateUrl: './app.html',
  host: { class: 'block' },
})
export class App {}
