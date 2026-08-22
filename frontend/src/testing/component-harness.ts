import { Type, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';

export interface MountedVm<T> {
  /** The component instance, typed loosely so protected computeds are readable. */
  vm: T & Record<string, unknown>;
  setInput: (name: string, value: unknown) => void;
}

/** Never calls `detectChanges()`, so the lifecycle hooks where components do their network I/O never run. */
export function mountVm<T>(
  type: Type<T>,
  inputs: Record<string, unknown> = {},
  providers: unknown[] = [],
): MountedVm<T> {
  TestBed.configureTestingModule({
    imports: [type],
    providers: [provideZonelessChangeDetection(), ...(providers as never[])],
  });
  const fixture = TestBed.createComponent(type);
  for (const [name, value] of Object.entries(inputs)) fixture.componentRef.setInput(name, value);
  return {
    vm: fixture.componentInstance as T & Record<string, unknown>,
    setInput: (name, value) => { fixture.componentRef.setInput(name, value); },
  };
}

export interface MountedDom {
  text: () => string;
  query: (selector: string) => HTMLElement | null;
  queryAll: (selector: string) => HTMLElement[];
  textAll: (selector: string) => string[];
  dispatch: (target: HTMLElement, event: Event) => void;
  click: (selector: string) => void;
  setInput: (name: string, value: unknown) => void;
  on: (name: string) => unknown[];
  detectChanges: () => void;
}

export function mountDom<T>(
  type: Type<T>,
  inputs: Record<string, unknown> = {},
  providers: unknown[] = [],
): MountedDom {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [type],
    providers: [provideZonelessChangeDetection(), ...(providers as never[])],
  });
  const fixture = TestBed.createComponent(type);
  for (const [name, value] of Object.entries(inputs)) fixture.componentRef.setInput(name, value);
  fixture.detectChanges();
  const host = fixture.nativeElement as HTMLElement;
  const clean = (el: Element): string => el.textContent.replace(/\s+/g, ' ').trim();
  // `querySelector` matches a selector against the whole document, so an unscoped `div > div:last-child` can bind to a TestBed wrapper outside the component.
  const scoped = (selector: string): string => selector.startsWith(':scope') ? selector : `:scope ${selector}`;
  const query = (selector: string): HTMLElement | null => host.querySelector(scoped(selector));
  return {
    text: () => clean(host),
    query,
    queryAll: (selector) => Array.from(host.querySelectorAll<HTMLElement>(scoped(selector))),
    textAll: (selector) => Array.from(host.querySelectorAll(scoped(selector))).map(clean),
    dispatch: (target, event) => { target.dispatchEvent(event); fixture.detectChanges(); },
    click: (selector) => {
      const el = query(selector);
      if (!el) throw new Error(`click: no element matches ${selector}`);
      el.click();
      fixture.detectChanges();
    },
    setInput: (name, value) => { fixture.componentRef.setInput(name, value); fixture.detectChanges(); },
    on: (name) => {
      const emitted: unknown[] = [];
      const source = (fixture.componentInstance as Record<string, unknown>)[name] as
        { subscribe: (fn: (value: unknown) => void) => unknown } | undefined;
      if (!source) throw new Error(`on: ${type.name} has no output named ${name}`);
      source.subscribe(value => emitted.push(value));
      return emitted;
    },
    detectChanges: () => { fixture.detectChanges(); },
  };
}

const BADGE_CLASS = /^badge-(\w+)$/;

export function badgeStatus(el: HTMLElement | null): string | null {
  for (const cls of Array.from(el?.classList ?? [])) {
    const match = BADGE_CLASS.exec(cls);
    if (match) return match[1] ?? null;
  }
  return null;
}
