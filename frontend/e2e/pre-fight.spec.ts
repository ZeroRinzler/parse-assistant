import { expect, test, Page } from '@playwright/test';
import { shows, showsAbility } from './support';

// Bench-only page, so this file spends no WCL budget; its figures are re-pinned from a render dump when the dataset moves.
// One shared page: the spec and encounter are selected once and every card asserts against that selection.
test.describe.configure({ mode: 'serial' });

let page: Page;

async function pick(label: string, option: string): Promise<void> {
  await page.getByRole('combobox', { name: label }).click();
  await page.getByRole('option', { name: option }).click();
}

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await page.goto('/pre');
  await pick('Class', 'Rogue');
  await pick('Spec', 'Subtlety');
  await pick('Encounter', 'Crown of the Cosmos');
});

test.afterAll(async () => {
  await page?.close();
});

test('selecting class, spec, and encounter loads that spec\'s plan', async () => {
  await expect(page.getByRole('combobox', { name: 'Class' })).toContainText('Rogue');
  await expect(page.getByRole('combobox', { name: 'Spec' })).toContainText('Subtlety');
  await expect(page.getByRole('combobox', { name: 'Encounter' })).toContainText('Crown of the Cosmos');
  const cooldownPlan = page.locator('wl-rotation-cd-plan');
  await shows(cooldownPlan, 'Shadow Blades');
  await shows(cooldownPlan, '0:06');
});

test('the northern sky export offers the top log\'s cooldown timings as a note', async () => {
  const card = page.locator('wl-northern-sky-export');
  await shows(card, 'Top-parse cooldown timings as a Northern Sky note.');

  await card.getByRole('button', { name: 'Export' }).click();
  const panel = page.locator('wl-flyover-panel');
  await expect(panel.getByRole('button', { name: 'Copy note' })).toBeVisible();
  await shows(panel, 'Cooldowns');
  await expect(panel.locator('mat-checkbox').filter({ hasText: 'Shadow Dance' })).toContainText('×24');
  await shows(panel, 'Defensives');
  await expect(panel.locator('mat-checkbox').filter({ hasText: 'Feint' })).toContainText('×14');
  await page.getByRole('button', { name: 'Close export' }).click();
});

test('gear shows the top-parse talent, trinket, and enchant consensus, and how the alt build differs', async () => {
  const gear = page.locator('wl-gear');
  await shows(gear, 'Top-parse gear consensus.');
  await shows(gear, 'Talents');
  await shows(gear, 'Most common build');
  await shows(gear, '50%');
  await shows(gear, 'of top parsers');
  await shows(gear, 'Alt build 1');
  await shows(gear, 'Added');
  await shows(gear, 'Ethereal Cloak');
  await shows(gear, 'Dropped');
  await shows(gear, 'Flawless Form');
  await shows(gear, 'Trinkets');
  await shows(gear, 'Light Company Guidon');
  await shows(gear, 'Trinket 1');
  await shows(gear, '100%');
  await shows(gear, 'Enchants');
  await shows(gear, 'Enchant Chest - Mark of the Worldsoul');
});

test('the cooldown plan lists first use, average uses, and the holds', async () => {
  const cooldownPlan = page.locator('wl-rotation-cd-plan');
  await shows(cooldownPlan, 'Cooldown plan');
  await shows(cooldownPlan, 'Shadow Blades');
  await shows(cooldownPlan, 'First use');
  await shows(cooldownPlan, 'Avg uses');
  await shows(cooldownPlan, '4.3');
  await shows(cooldownPlan, 'Holds');
  await shows(cooldownPlan, '2:55');
});

test('the defensive plan lists the consensus defensives', async () => {
  const defensivePlan = page.locator('wl-defensive-plan');
  await shows(defensivePlan, 'Defensive plan');
  await shows(defensivePlan, 'Cloak of Shadows');
  await shows(defensivePlan, 'First use');
  await shows(defensivePlan, '4:00');
  await shows(defensivePlan, 'Avg uses');
  await shows(defensivePlan, '1.4');
});

test('burst windows show the top-parse windows with their bench damage', async () => {
  const burstWindows = page.locator('wl-burst-windows');
  await shows(burstWindows, 'Damage in each burst window vs top parses.');
  await shows(burstWindows, 'window');
  await shows(burstWindows, '0:08 - 0:32');
  await shows(burstWindows, 'burst');
  await shows(burstWindows, '16.7M');
  await showsAbility(burstWindows, 'Eviscerate', '3.2M');
});

test('the positioning map opens anchored on the selected burst window', async () => {
  const openMap = page.getByRole('button', { name: 'Open positioning map' }).first();
  await expect(openMap).toBeVisible();
  await openMap.click();
  await shows(page, 'Positioning');
  await expect(page.locator('wl-map-canvas canvas')).toBeVisible();
  await shows(page, 'anchor 0:08');
  await shows(page, '● top parses');
  await page.getByRole('button', { name: 'Close map' }).click();
});
