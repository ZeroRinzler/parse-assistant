import { logWarn } from '../core/log';

/**
 * Latest-wins guard for feature-component loads. A component reloads whenever
 * its input signals change, and a slow earlier response must never overwrite a
 * newer one: run() tags each load, and only the most recent tag's apply/settled
 * callbacks fire. A rejected load logs a warning via logWarn (the view keeps its
 * current state); settled fires for the latest load whether it resolved or
 * rejected, so busy flags always clear.
 */
export class LatestLoad {
  private token = 0;

  run<T>(load: Promise<T>, handlers: { context: string; apply: (value: T) => void; settled?: () => void }): void {
    const token = ++this.token;
    void load
      .then(value => { if (token === this.token) handlers.apply(value); })
      .catch(err => logWarn(handlers.context, err))
      .finally(() => { if (token === this.token) handlers.settled?.(); });
  }
}
