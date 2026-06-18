/**
 * Lightweight harness for testing signal view-models.
 *
 * Component `computed()`s are instance fields, so they need a constructed
 * instance and (for `input.required`) the `ComponentRef.setInput` machinery -
 * which only `TestBed.createComponent` provides. This helper does the minimum:
 * configure a zoneless TestBed, create the component, apply each input via
 * `setInput`, and hand back the instance so a test can read the computed
 * signals directly.
 *
 * It deliberately does NOT call `detectChanges()`, so lifecycle hooks
 * (`ngOnInit` / `ngOnChanges`) - where components do their network I/O - never
 * run. Setting an input signal and reading a `computed()` is synchronous and
 * glitch-free, so no change-detection pass is required to observe derived state.
 */
import { Type, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';

export interface MountedVm<T> {
  /** The component instance, typed loosely so protected computeds are readable. */
  vm: T & Record<string, unknown>;
  /** Update an input signal after mount. */
  setInput(name: string, value: unknown): void;
}

/**
 * Mount a component for view-model testing.
 *
 * @param type     the component class
 * @param inputs   initial input signal values (applied via `setInput`)
 * @param providers extra providers (stubs for injected services)
 */
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
    setInput: (name, value) => fixture.componentRef.setInput(name, value),
  };
}
