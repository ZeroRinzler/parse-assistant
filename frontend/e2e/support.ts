import { expect, Locator, Page } from '@playwright/test';

/** Asserts the scope shows the text: whole-element match for a string, raw-text for a pattern, first hit when it repeats. */
export async function shows(scope: Page | Locator, text: string | RegExp): Promise<void> {
  const match = typeof text === 'string' ? scope.getByText(text, { exact: true }) : scope.getByText(text);
  await expect(match.first()).toBeVisible();
}

/** Asserts the ability breakdown lists `ability` with `topAverage`; row-scoped because that cell also holds a hidden label. */
export async function showsAbility(scope: Locator, ability: string, topAverage: string): Promise<void> {
  const row = scope.locator('wl-compact-ability-row').filter({ hasText: ability }).first();
  await expect(row).toContainText(topAverage);
}
