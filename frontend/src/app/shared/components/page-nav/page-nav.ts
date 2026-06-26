import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { map } from 'rxjs';
import { BreakpointObserver } from '@angular/cdk/layout';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatSidenavModule } from '@angular/material/sidenav';
import { MatListModule } from '@angular/material/list';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';

const GITHUB_URL = 'https://github.com/gpolcode/warcraft-learner';
const MOBILE_QUERY = '(max-width: 600px)';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-page-nav',
  imports: [
    RouterLink, RouterLinkActive, MatToolbarModule, MatSidenavModule, MatListModule,
    MatButtonModule, MatIconModule, MatMenuModule,
  ],
  templateUrl: './page-nav.html',
  host: { class: 'flex flex-col h-[100dvh]' },
})
export class PageNavComponent {
  protected readonly githubUrl = GITHUB_URL;
  private readonly breakpoints = inject(BreakpointObserver);

  protected readonly isMobile = toSignal(
    this.breakpoints.observe(MOBILE_QUERY).pipe(map(result => result.matches)),
    { initialValue: false },
  );

  // Desktop: persistent drawer, open by default. Mobile: overlay, closed by default.
  protected readonly desktopOpen = signal(true);
  protected readonly mobileOpen = signal(false);

  protected readonly sidenavMode = computed<'over' | 'side'>(() =>
    this.isMobile() ? 'over' : 'side');
  protected readonly sidenavOpened = computed(() =>
    this.isMobile() ? this.mobileOpen() : this.desktopOpen());

  protected toggleNav(): void {
    if (this.isMobile()) {
      this.mobileOpen.update(open => !open);
    } else {
      this.desktopOpen.update(open => !open);
    }
  }

  protected onNavigate(): void {
    if (this.isMobile()) {
      this.mobileOpen.set(false);
    }
  }

  protected onOpenedChange(opened: boolean): void {
    if (this.isMobile()) {
      this.mobileOpen.set(opened);
    } else {
      this.desktopOpen.set(opened);
    }
  }
}
