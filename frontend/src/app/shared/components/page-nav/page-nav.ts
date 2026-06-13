import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatTooltipModule } from '@angular/material/tooltip';
import { WclAuthService } from '../../../core/services/wcl-auth';

const GITHUB_URL = 'https://github.com/gpolcode/warcraft-learner';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-page-nav',
  imports: [RouterLink, RouterLinkActive, MatButtonModule, MatIconModule, MatMenuModule, MatTooltipModule],
  templateUrl: './page-nav.html',
  styleUrl: './page-nav.scss',
})
export class PageNavComponent {
  protected readonly auth = inject(WclAuthService);
  protected readonly githubUrl = GITHUB_URL;

  protected signIn(): void {
    this.auth.login();
  }

  protected signOut(): void {
    this.auth.logout();
  }
}
