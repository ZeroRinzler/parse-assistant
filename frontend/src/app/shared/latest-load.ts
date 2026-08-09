import { logWarn } from '../core/log';

/** Latest-wins guard: a slow earlier response must never overwrite a newer one, so only the most recent run()'s callbacks fire. */
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
