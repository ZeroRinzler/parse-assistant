import { OutputEmitterRef, Signal, computed, linkedSignal, resource } from '@angular/core';
import { Result } from '../../core/result';
import { logWarn } from '../../core/log';
import { RenderableLoadError } from '../components/load-state/load-state';

export interface LoadResourceConfig<P, T> {
  params: () => P;
  load: (params: P) => Promise<Result<T>>;
  context: string;
  /** Applies to an ok result only; a failed load is never available. */
  availableWhen?: (value: T) => boolean;
  initialAvailable?: boolean;
  busyChange: OutputEmitterRef<boolean>;
  availableChange?: OutputEmitterRef<boolean>;
}

export interface LoadResource<T> {
  readonly value: Signal<T | null>;
  readonly available: Signal<boolean>;
  /** Null for a `missing` result, which is the waiting state rather than an error. */
  readonly error: Signal<RenderableLoadError | null>;
}

export function loadResource<P, T>(config: LoadResourceConfig<P, T>): LoadResource<T> {
  const availableOf = (result: Result<T>): boolean => result.ok && (config.availableWhen?.(result.value) ?? true);

  const load = resource<Result<T> | undefined, P>({
    params: config.params,
    loader: async ({ params, abortSignal }) => {
      let result: Result<T>;
      try {
        result = await config.load(params);
      } catch (cause) {
        logWarn(config.context, cause);
        if (!abortSignal.aborted) config.busyChange.emit(false);
        // Undefined leaves the last applied result in place: a load that never produced a `Result` states nothing about the card.
        return undefined;
      }
      // A superseded load must neither write nor emit; the newer one owns both.
      if (abortSignal.aborted) return undefined;
      if (!result.ok && result.error.kind === 'permanent') logWarn(result.error.id, result.error.context);
      config.availableChange?.emit(availableOf(result));
      config.busyChange.emit(false);
      return result;
    },
  });

  // The resource clears its value while loading, so the last applied result is what keeps the card rendered until the new one lands.
  const applied = linkedSignal<Result<T> | undefined, Result<T> | undefined>({
    source: load.value,
    computation: (next, previous) => next ?? previous?.value,
  });

  return {
    value: computed(() => {
      const result = applied();
      return result?.ok ? result.value : null;
    }),
    available: computed(() => {
      const result = applied();
      return result ? availableOf(result) : (config.initialAvailable ?? false);
    }),
    error: computed(() => {
      const result = applied();
      return !result || result.ok || result.error.kind === 'missing' ? null : result.error;
    }),
  };
}
