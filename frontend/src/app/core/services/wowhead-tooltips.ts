/** Injects the Wowhead tooltip scripts on first use, keeping them off pages with no spell/item links. */
import { DOCUMENT } from '@angular/common';
import { Injectable, inject } from '@angular/core';
import { logWarn } from '../log';

const CONFIG_SRC = 'wh-tooltips-config.js';
const TOOLTIPS_SRC = 'https://wow.zamimg.com/js/tooltips.js';

interface WowheadPower {
  refreshLinks?: () => void;
}
type WowheadWindow = Window & { $WowheadPower?: WowheadPower };

@Injectable({ providedIn: 'root' })
export class WowheadTooltipsService {
  private readonly document = inject(DOCUMENT);
  private loaded = false;
  // tooltips.js enhances each link once on load and never re-observes the DOM.
  private ready = false;
  private refreshScheduled = false;

  ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;

    const config = this.document.createElement('script');
    config.src = CONFIG_SRC;
    config.addEventListener('error', (err) => { logWarn('wowhead tooltips config load', err); });
    // Chain tooltips.js off config's load: it needs the whTooltips global, and dynamically inserted scripts have no execution-order guarantee.
    config.addEventListener('load', () => {
      const tooltips = this.document.createElement('script');
      tooltips.src = TOOLTIPS_SRC;
      tooltips.addEventListener('error', (err) => { logWarn('wowhead tooltips script load', err); });
      tooltips.addEventListener('load', () => {
        this.ready = true;
        this.refreshLinks();
      });
      this.document.head.appendChild(tooltips);
    });
    this.document.head.appendChild(config);
  }

  /** Re-scan so links rendered after the load-time scan get enhanced; coalesced per microtask, no-op until ready. */
  refreshLinks(): void {
    if (this.refreshScheduled) return;
    this.refreshScheduled = true;
    queueMicrotask(() => {
      this.refreshScheduled = false;
      if (!this.ready) return;
      (this.document.defaultView as WowheadWindow | null)?.$WowheadPower?.refreshLinks?.();
    });
  }
}
