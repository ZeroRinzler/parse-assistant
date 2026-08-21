import { assert, vi } from 'vitest';
import { OutputEmitterRef, WritableSignal, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Result } from '../../core/result';
import { LoadResource, loadResource } from './load-resource';

export const LOAD_CONTEXT = 'feature.loadView';
export const FIRST_PARAMS = 'first-selection';
export const SECOND_PARAMS = 'second-selection';
export const FIRST_VALUE = 'first view';
export const SECOND_VALUE = 'second view';
export const EMPTY_VALUE = '';
export const OUTAGE_MESSAGE = 'WCL is unreachable right now.';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface HarnessOptions {
  availableWhen?: (value: string) => boolean;
  initialAvailable?: boolean;
  withAvailableChange?: boolean;
}

interface Harness {
  card: LoadResource<string>;
  params: WritableSignal<string>;
  busy: boolean[];
  availability: boolean[];
  started: string[];
  settle: (params: string, result: Result<string>) => void;
  fail: (params: string, cause: unknown) => void;
  start: () => void;
}

export function harness(options: HarnessOptions = {}): Harness {
  TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
  const params = signal(FIRST_PARAMS);
  const started: string[] = [];
  const pending = new Map<string, Deferred<Result<string>>>();
  const busy: boolean[] = [];
  const availability: boolean[] = [];

  const card = TestBed.runInInjectionContext(() => {
    const busyChange = new OutputEmitterRef<boolean>();
    const availableChange = new OutputEmitterRef<boolean>();
    busyChange.subscribe(value => busy.push(value));
    availableChange.subscribe(value => availability.push(value));
    return loadResource<string, string>({
      params,
      load: selection => {
        started.push(selection);
        const load = deferred<Result<string>>();
        pending.set(selection, load);
        return load.promise;
      },
      context: LOAD_CONTEXT,
      availableWhen: options.availableWhen,
      initialAvailable: options.initialAvailable,
      busyChange,
      availableChange: options.withAvailableChange === false ? undefined : availableChange,
    });
  });

  function take(selection: string): Deferred<Result<string>> {
    const load = pending.get(selection);
    assert.exists(load);
    return load;
  }

  return {
    card, params, busy, availability, started,
    settle: (selection, result) => { take(selection).resolve(result); },
    fail: (selection, cause) => { take(selection).reject(cause); },
    start: () => { TestBed.tick(); },
  };
}

// A settled load runs through the loader body, the resource, and the linked signal; fewer turns than this reads state mid-flight.
const TURNS_TO_APPLY_A_SETTLED_LOAD = 5;

/** `whenStable` would block on loads still in flight; this advances past settled ones only. */
export async function drain(): Promise<void> {
  for (let turn = 0; turn < TURNS_TO_APPLY_A_SETTLED_LOAD; turn++) await Promise.resolve();
  TestBed.tick();
}

export function spyOnConsoleWarn() {
  return vi.spyOn(console, 'warn').mockImplementation(() => undefined);
}
