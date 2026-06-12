import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { PageNavComponent } from './shared/components/page-nav/page-nav';

@Component({
  selector: 'wl-root',
  imports: [RouterOutlet, PageNavComponent],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {}
