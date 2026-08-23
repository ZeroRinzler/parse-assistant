import { Injectable } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class LoggerService {

  /** Minimal logging helper for best-effort operations that must not crash the UI. */
  logWarn(context: string, err: unknown): void {
    console.warn(`[warcraft-learner] ${context}:`, err);
  }
}
