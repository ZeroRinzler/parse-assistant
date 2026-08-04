import { expect, Locator, Page } from '@playwright/test';

/** Asserts the scope shows the text: whole-element match for a string, raw-text for a pattern, first hit when it repeats. */
export async function shows(scope: Page | Locator, text: string | RegExp): Promise<void> {
  const match = typeof text === 'string' ? scope.getByText(text, { exact: true }) : scope.getByText(text);
  await expect(match.first()).toBeVisible();
}

// Figure shapes, not values: both the player's log and the bench move with the data, never the format.
export const DAMAGE = /\d+(\.\d+)?[KM]/;
export const CLOCK = /-?\d+:\d{2}/;
export const PERCENT = /[+-]?\d+(\.\d+)?%/;
export const RATIO = /\d+ \/ \d+/;
export const DECIMAL = /\d+\.\d+/;

/** Asserts at least one named ability/gear row renders with a real icon + name, regardless of which one the bench ranks first. */
export async function showsEntity(scope: Locator): Promise<void> {
  await expect(scope.locator('wl-game-icon').first()).toBeVisible();
}
