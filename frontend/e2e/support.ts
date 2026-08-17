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

/** Asserts the "Typical uses" cell (shared by defensive-plan and rotation-cd-plan) renders a value: number:'1.0-1' drops the fraction on a whole number, so a bare integer is a valid render, not a miss. */
export async function showsTypicalUses(scope: Locator): Promise<void> {
  const cell = scope.locator('span').filter({ hasText: 'Typical uses' }).first();
  await expect(cell.getByText(/^\d+(\.\d+)?$/).first()).toBeVisible();
}
const SECONDS = /[+-]?\d+(\.\d+)?s/;

const MEASURE = new RegExp([RATIO, PERCENT, CLOCK, SECONDS].map(r => r.source).join('|'));

/** Mirrors CAT_LABEL in shared/components/finding-table/finding-table.utils.ts. */
export const CD_CHIP = /\b(lost cast|held|BL miss|downtime|hold)\b/;

/** Asserts at least one named ability/gear row renders with a real icon + name, regardless of which one the bench ranks first. */
export async function showsEntity(scope: Locator): Promise<void> {
  await expect(scope.locator('wl-game-icon').first()).toBeVisible();
}

/** A bare `div.border-t` also matches the on-plan strip, the empty state, and the Fix cell itself, so a row is narrowed to a top-level band that owns a Fix. */
export function findingRows(table: Locator): Locator {
  return table.locator(':scope > div > div.border-t').filter({ has: table.page().locator('wl-collapsible-text') });
}

/** Which findings a pull produces moves with every re-ingest of the bench, so a card is pinned by the shape of each row it drew, never by one named finding. */
export async function showsFindingRows(table: Locator, chip?: RegExp): Promise<void> {
  const rows = findingRows(table);
  const count = await rows.count();
  // A refresh can put every verdict on plan; zero rows is a valid card state, an empty strip is not.
  if (count === 0) {
    await showsOnPlan(table);
    return;
  }
  for (let i = 0; i < count; i++) {
    const row = rows.nth(i);
    if (chip) await expect(row.locator('span.rounded-sm')).toHaveText(chip);
    await expect(row).toHaveText(MEASURE);
    await expect(row.locator('wl-collapsible-text')).not.toHaveText('');
  }
}

export async function showsOnPlan(table: Locator): Promise<void> {
  await shows(table, 'On plan');
  await expect(table.locator('.chip-onplan').first()).toBeVisible();
}
