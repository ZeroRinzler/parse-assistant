import { PendingTasks, inject } from '@angular/core';
import { logWarn } from '../core/log';

/** Latest-wins guard: a slow earlier response must never overwrite a newer one, so only the most recent run()'s callbacks fire. */
export class LatestLoad {
  // Holding the app unstable for the whole chain is what lets a caller await a load it has no handle on.
  private readonly pending = inject(PendingTasks);
  private token = 0;

  run<T>(load: Promise<T>, handlers: { context: string; apply: (value: T) => void; settled?: () => void }): void {
    const token = ++this.token;
    const done = this.pending.add();
    void load
      .then(value => { if (token === this.token) handlers.apply(value); })
      .catch((err: unknown) => { logWarn(handlers.context, err); })
      .finally(() => { if (token === this.token) handlers.settled?.(); })
      .finally(done);
  }
}
