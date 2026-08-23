import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, viewChild } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { map } from 'rxjs';
import { BreakpointObserver } from '@angular/cdk/layout';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatSidenavModule, MatSidenavContainer } from '@angular/material/sidenav';
import { MatListModule } from '@angular/material/list';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule, MatIconRegistry } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { DomSanitizer } from '@angular/platform-browser';
import { NavStateStore } from '../../../core/state/nav-state-store';

const GITHUB_URL = 'https://github.com/gpolcode/warcraft-learner';
const NEW_ISSUE_URL = `${GITHUB_URL}/issues/new`;
const MOBILE_QUERY = '(max-width: 600px)';

const GITHUB_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
  <path d="M12 0C5.37 0 0 5.373 0 12c0 5.303 3.438 9.8 8.205 11.387.6.113.82-.258.82-.577
    0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61-.546-1.387-1.333-1.756-1.333-1.756
    -1.089-.745.083-.73.083-.73 1.205.084 1.84 1.237 1.84 1.237 1.07 1.834 2.807 1.304 3.492.997
    .107-.775.418-1.305.762-1.605-2.665-.305-5.467-1.334-5.467-5.931 0-1.31.465-2.381 1.235-3.221
    -.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138
    3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.911 1.23 3.221
    0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222 0 1.606-.015 2.896-.015 3.286
    0 .315.21.69.825.57C20.565 21.796 24 17.3 24 12c0-6.627-5.373-12-12-12z"/>
</svg>`;

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-page-nav',
  imports: [
    RouterLink, RouterLinkActive, MatToolbarModule, MatSidenavModule, MatListModule,
    MatButtonModule, MatIconModule, MatTooltipModule,
  ],
  templateUrl: './page-nav.html',
  host: { class: 'flex flex-col h-[100dvh]' },
})
export class PageNav {
  protected readonly githubUrl = GITHUB_URL;
  protected readonly newIssueUrl = NEW_ISSUE_URL;
  private readonly breakpoints = inject(BreakpointObserver);
  private readonly navState = inject(NavStateStore);

  protected readonly isMobile = toSignal(
    this.breakpoints.observe(MOBILE_QUERY).pipe(map(result => result.matches)),
    { initialValue: false },
  );

  // Mobile: modal drawer, closed by default. Desktop: permanent drawer that collapses to an icons-only rail restored from the last session.
  protected readonly mobileOpen = signal(false);
  protected readonly desktopCollapsed = signal(this.navState.loadCollapsed());

  protected readonly sidenavMode = computed<'over' | 'side'>(() =>
    this.isMobile() ? 'over' : 'side');
  // The desktop drawer stays open at all times; the hamburger toggles its width, not its opened state.
  protected readonly sidenavOpened = computed(() =>
    this.isMobile() ? this.mobileOpen() : true);
  protected readonly railCollapsed = computed(() =>
    !this.isMobile() && this.desktopCollapsed());

  private readonly container = viewChild(MatSidenavContainer);

  constructor() {
    // This nav link is the only `svgIcon="github"` consumer, so the icon registers here.
    inject(MatIconRegistry).addSvgIconLiteral(
      'github',
      inject(DomSanitizer).bypassSecurityTrustHtml(GITHUB_SVG),
    );

    // Material only recomputes the sidenav content margin on open/close, not on an already-open drawer's width change, so force it after the rail's width class swaps.
    effect(onCleanup => {
      this.railCollapsed();
      const frame = requestAnimationFrame(() => this.container()?.updateContentMargins());
      // Without this a frame surviving destruction measures a torn-down container.
      onCleanup(() => { cancelAnimationFrame(frame); });
    });
  }

  protected toggleNav(): void {
    if (this.isMobile()) {
      this.mobileOpen.update(open => !open);
    } else {
      this.desktopCollapsed.update(collapsed => !collapsed);
      this.navState.saveCollapsed(this.desktopCollapsed());
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
    }
  }
}
