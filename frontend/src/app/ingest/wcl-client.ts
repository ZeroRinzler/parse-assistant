// An interface (not a concrete class) so tests can inject a fake client with no real OAuth/HTTP.
export interface WclQueryClient {
  query<T = unknown, TVars extends object = Record<string, never>>(gql: string, variables?: TVars): Promise<T>;
  assertBudget(margin: number): Promise<void>;
}

// Not retried: the limit resets on an hourly boundary and an hourly task must not stall waiting for it.
export class BudgetExceededError extends Error {
  override name = 'BudgetExceededError';
  constructor(message: string) { super(message); }
}
