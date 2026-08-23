import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { PageNav } from './shared/components/page-nav/page-nav';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-root',
  imports: [RouterOutlet, PageNav],
  templateUrl: './app.html',
  host: { class: 'block' },
})
export class App {}
