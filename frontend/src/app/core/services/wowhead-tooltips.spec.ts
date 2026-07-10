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

describe('WowheadTooltipsService', () => {
  beforeEach(() => {
    for (const s of Array.from(document.head.querySelectorAll('script'))) {
      if (s.src.includes('tooltips') || s.src.includes(CONFIG_SRC)) s.remove();
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
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
});
