import { ChangeDetectionStrategy, Component, OnInit, inject } from '@angular/core';
import { Router, RouterOutlet, NavigationEnd } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { filter, map } from 'rxjs';
import { PageNavComponent } from './shared/components/page-nav/page-nav';
import { AuthBannerComponent } from './shared/components/auth-banner/auth-banner';
import { PositioningPanelComponent } from './shared/components/positioning-panel/positioning-panel';
import { WclAuthService } from './core/services/wcl-auth';
import { WclApiService } from './core/services/wcl-api';
import { PositioningPanelService } from './core/services/positioning-panel';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-root',
  imports: [RouterOutlet, PageNavComponent, AuthBannerComponent, PositioningPanelComponent],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App implements OnInit {
  private readonly auth = inject(WclAuthService);
  private readonly wclApi = inject(WclApiService);
  private readonly router = inject(Router);
  protected readonly panel = inject(PositioningPanelService);

  protected readonly isLoggedIn = this.auth.isLoggedIn;
  protected readonly isCallbackRoute = toSignal(
    this.router.events.pipe(
      filter(e => e instanceof NavigationEnd),
      map(() => this.router.url.startsWith('/callback')),
    ),
    { initialValue: this.router.url.startsWith('/callback') },
  );

  ngOnInit(): void {
    if (this.auth.isLoggedIn()) {
      this.wclApi.fetchUserCharacters().catch(() => {});
    }
  }
}
