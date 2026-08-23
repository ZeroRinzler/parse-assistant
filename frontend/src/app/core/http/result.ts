// Kept Angular-free so the pure transforms and the headless Node ingestion can import it.
export type Result<T, E = LoadError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

// `missing` is deliberately not an error: it feeds the bench-empty waiting state, not an error banner.
export type LoadError =
  | { readonly kind: 'missing'; readonly message: string }
  | { readonly kind: 'transient'; readonly message: string }
  | { readonly kind: 'permanent'; readonly message: string; readonly id: string; readonly context?: unknown };

export class Results {
  private constructor() {}

  static ok<T>(value: T): Result<T, never> {
    return { ok: true, value };
  }

  private static err<E>(error: E): Result<never, E> {
    return { ok: false, error };
  }

  static missing(message: string): Result<never> {
    return Results.err({ kind: 'missing', message });
  }

  static transient(message: string): Result<never> {
    return Results.err({ kind: 'transient', message });
  }

  static permanent(message: string, id: string, context?: unknown): Result<never> {
    return Results.err({ kind: 'permanent', message, id, context });
  }
}
