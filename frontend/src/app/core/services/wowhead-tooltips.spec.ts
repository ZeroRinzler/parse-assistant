import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { DOCUMENT } from '@angular/common';
import { WowheadTooltipsService } from './wowhead-tooltips';

const CONFIG_SRC = 'wh-tooltips-config.js';
const TOOLTIPS_SRC = 'https://wow.zamimg.com/js/tooltips.js';

function injectedScripts(doc: Document): HTMLScriptElement[] {
  return Array.from(doc.head.querySelectorAll('script'));
}

function scriptWith(doc: Document, srcFragment: string): HTMLScriptElement | undefined {
  return injectedScripts(doc).find((s) => s.src.includes(srcFragment));
}

function setup(): { service: WowheadTooltipsService; doc: Document } {
  TestBed.configureTestingModule({ providers: [WowheadTooltipsService] });
  return {
    service: TestBed.inject(WowheadTooltipsService),
    doc: TestBed.inject(DOCUMENT),
  };
}

// Stub of the $WowheadPower global that tooltips.js publishes; the service calls its refreshLinks.
type PowerWindow = Window & { $WowheadPower?: { refreshLinks: () => void } };

function stubWowheadPower(doc: Document): ReturnType<typeof vi.fn> {
  const refreshLinks = vi.fn();
  (doc.defaultView as PowerWindow).$WowheadPower = { refreshLinks };
  return refreshLinks;
}

// Drive both script `load` events so the service reaches its `ready` state.
function finishLoading(service: WowheadTooltipsService, doc: Document): void {
  service.ensureLoaded();
  scriptWith(doc, CONFIG_SRC)!.dispatchEvent(new Event('load'));
  scriptWith(doc, TOOLTIPS_SRC)!.dispatchEvent(new Event('load'));
}

const flushMicrotasks = () => Promise.resolve();

describe('WowheadTooltipsService', () => {
  beforeEach(() => {
    for (const s of Array.from(document.head.querySelectorAll('script'))) {
      if (s.src.includes('tooltips') || s.src.includes(CONFIG_SRC)) s.remove();
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (document.defaultView as PowerWindow).$WowheadPower;
    for (const s of Array.from(document.head.querySelectorAll('script'))) {
      if (s.src.includes('tooltips') || s.src.includes(CONFIG_SRC)) s.remove();
    }
  });

  it('injects the config script first and defers tooltips.js until the config loads', () => {
    const { service, doc } = setup();

    service.ensureLoaded();

    expect(scriptWith(doc, CONFIG_SRC)).toBeDefined();
    expect(scriptWith(doc, TOOLTIPS_SRC)).toBeUndefined();

    scriptWith(doc, CONFIG_SRC)!.dispatchEvent(new Event('load'));

    expect(scriptWith(doc, TOOLTIPS_SRC)).toBeDefined();
  });

  it('injects the scripts only once no matter how many links request them', () => {
    const { service, doc } = setup();

    service.ensureLoaded();
    scriptWith(doc, CONFIG_SRC)!.dispatchEvent(new Event('load'));
    service.ensureLoaded();
    service.ensureLoaded();

    expect(injectedScripts(doc).filter((s) => s.src.includes(CONFIG_SRC))).toHaveLength(1);
    expect(injectedScripts(doc).filter((s) => s.src.includes(TOOLTIPS_SRC))).toHaveLength(1);
  });

  it('does not throw and logs a warning when a script fails to load', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { service, doc } = setup();

    service.ensureLoaded();
    scriptWith(doc, CONFIG_SRC)!.dispatchEvent(new Event('error'));

    expect(warn).toHaveBeenCalled();
  });

  describe('refreshLinks (re-scan for links added after the one-time load scan)', () => {
    it('re-scans via $WowheadPower once the tooltip script has loaded', async () => {
      const { service, doc } = setup();
      const refreshLinks = stubWowheadPower(doc);

      finishLoading(service, doc);
      await flushMicrotasks();
      refreshLinks.mockClear(); // ignore the automatic re-scan the load itself triggers

      service.refreshLinks();
      await flushMicrotasks();

      expect(refreshLinks).toHaveBeenCalledTimes(1);
    });

    it('is a no-op before the script is ready, so it never throws on a missing global', async () => {
      const { service, doc } = setup();
      const refreshLinks = stubWowheadPower(doc);

      service.ensureLoaded(); // scripts requested but their load events have not fired
      service.refreshLinks();
      await flushMicrotasks();

      expect(refreshLinks).not.toHaveBeenCalled();
    });

    it('coalesces a burst of calls into a single scan per microtask', async () => {
      const { service, doc } = setup();
      const refreshLinks = stubWowheadPower(doc);
      finishLoading(service, doc);
      refreshLinks.mockClear();

      service.refreshLinks();
      service.refreshLinks();
      service.refreshLinks();
      await flushMicrotasks();

      expect(refreshLinks).toHaveBeenCalledTimes(1);
    });
  });
});
