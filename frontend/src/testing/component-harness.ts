/** Harness for testing signal view-models; deliberately does NOT call `detectChanges()`, so lifecycle hooks (`ngOnInit`/`ngOnChanges`) - where components do their network I/O - never run. */
import { Type, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';

export interface MountedVm<T> {
  /** The component instance, typed loosely so protected computeds are readable. */
  vm: T & Record<string, unknown>;
  setInput: (name: string, value: unknown) => void;
}

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
