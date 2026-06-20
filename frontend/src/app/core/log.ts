/** Minimal logging helper for best-effort operations that must not crash the UI. */
export function logWarn(context: string, err: unknown): void {
  console.warn(`[warcraft-learner] ${context}:`, err);
}
