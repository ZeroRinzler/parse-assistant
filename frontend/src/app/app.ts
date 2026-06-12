import { ChangeDetectionStrategy, Component, OnInit, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { PageNavComponent } from './shared/components/page-nav/page-nav';
import { WclAuthService } from './core/services/wcl-auth';
import { WclApiService } from './core/services/wcl-api';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-root',
  imports: [RouterOutlet, PageNavComponent],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App implements OnInit {
  private readonly auth = inject(WclAuthService);
  private readonly wclApi = inject(WclApiService);

  ngOnInit(): void {
    if (this.auth.isLoggedIn()) {
      this.wclApi.fetchUserCharacters().catch(() => {});
    }
  }
}
