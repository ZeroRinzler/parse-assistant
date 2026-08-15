// Kept Angular-free so the pure transforms and the headless Node ingestion can import it.
export type Result<T, E = LoadError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

// `missing` is deliberately not an error: it feeds the bench-empty waiting state, not an error banner.
export type LoadError =
  | { readonly kind: 'missing'; readonly message: string }
  | { readonly kind: 'transient'; readonly message: string }
  | { readonly kind: 'permanent'; readonly message: string; readonly id: string; readonly context?: unknown };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

export function missing(message: string): Result<never> {
  return err({ kind: 'missing', message });
}

export function transient(message: string): Result<never> {
  return err({ kind: 'transient', message });
}

export function permanent(message: string, id: string, context?: unknown): Result<never> {
  return err({ kind: 'permanent', message, id, context });
}
