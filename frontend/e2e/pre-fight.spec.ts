import { expect, test, Page } from '@playwright/test';
import { shows, showsEntity, showsTypicalUses, CLOCK, DAMAGE, PERCENT } from './support';

// Bench-only page (no WCL budget spent): one shared page, spec and encounter picked once, every card asserts against it.
test.describe.configure({ mode: 'serial' });

let page: Page;

async function pick(label: string, option: string): Promise<void> {
  await page.getByRole('combobox', { name: label }).click();
  await page.getByRole('option', { name: option }).click();
}

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await page.goto('/pre');
  await pick('Class', 'Warrior');
  await pick('Spec', 'Arms');
  await pick('Encounter', "Nek'zali the Soulcoiler");
});

test.afterAll(async () => {
  await page.close();
});

test('selecting class, spec, and encounter loads that spec\'s plan', async () => {
  await expect(page.getByRole('combobox', { name: 'Class' })).toContainText('Warrior');
  await expect(page.getByRole('combobox', { name: 'Spec' })).toContainText('Arms');
  await expect(page.getByRole('combobox', { name: 'Encounter' })).toContainText("Nek'zali the Soulcoiler");
  const cooldownPlan = page.locator('wl-rotation-cd-plan');
  await showsEntity(cooldownPlan);
  await shows(cooldownPlan, CLOCK);
});

test('the northern sky export offers the top log\'s cooldown timings as a note', async () => {
  const card = page.locator('wl-northern-sky-export');
  await shows(card, 'Top-parse cooldown timings as a Northern Sky note.');

  await card.getByRole('button', { name: 'Export' }).click();
  const panel = page.locator('wl-flyover-panel');
  await expect(panel.getByRole('button', { name: 'Copy note' })).toBeVisible();
  await shows(panel, 'Cooldowns');
  await shows(panel, 'Defensives');
  const checkboxes = panel.locator('mat-checkbox');
  const checkboxCount = await checkboxes.count();
  expect(checkboxCount).toBeGreaterThan(0);
  for (let i = 0; i < checkboxCount; i++) await expect(checkboxes.nth(i)).toContainText(/×\d+/);
  await page.getByRole('button', { name: 'Close export' }).click();
});

test('gear shows the top-parse talent, trinket, and enchant consensus, and how the alt build differs', async () => {
  const gear = page.locator('wl-gear');
  await shows(gear, 'Top-parse gear consensus.');
  const talents = gear.locator('div.border-t').filter({ hasText: 'Talents' }).first();
  await shows(talents, 'Most common build');
  await shows(talents, PERCENT);
  await shows(talents, 'of top parsers');
  await shows(talents, 'Alt build 1');
  await shows(talents, 'Added');
  await shows(talents, 'Dropped');
  await showsEntity(talents);
  const trinkets = gear.locator('div.border-t').filter({ hasText: 'Trinkets' }).first();
  await expect(trinkets.locator('a[href*="wowhead.com/item="]').first()).toBeVisible();
  await shows(trinkets, 'Trinket 1');
  await shows(trinkets, PERCENT);
  const enchants = gear.locator('div.border-t').filter({ hasText: 'Enchants' }).first();
  await expect(enchants).toContainText(PERCENT);
});

test('the cooldown plan lists first use, typical uses, and the holds', async () => {
  const cooldownPlan = page.locator('wl-rotation-cd-plan');
  await shows(cooldownPlan, 'Cooldown plan');
  await showsEntity(cooldownPlan);
  await shows(cooldownPlan, 'First use');
  await showsTypicalUses(cooldownPlan);
  await shows(cooldownPlan, 'Holds');
  await shows(cooldownPlan, CLOCK);
});

test('the defensive plan lists the consensus defensives', async () => {
  const defensivePlan = page.locator('wl-defensive-plan');
  await shows(defensivePlan, 'Defensive plan');
  await showsEntity(defensivePlan);
  await shows(defensivePlan, 'First use');
  await shows(defensivePlan, CLOCK);
  await showsTypicalUses(defensivePlan);
});

test('burst windows show the top-parse windows with their bench damage', async () => {
  const burstWindows = page.locator('wl-burst-windows');
  await shows(burstWindows, 'Damage in each burst window vs top parses.');
  await shows(burstWindows, 'window');
  await shows(burstWindows, /\d+:\d{2} - \d+:\d{2}/);
  await shows(burstWindows, 'burst');
  await shows(burstWindows, DAMAGE);
  await showsEntity(burstWindows);
});

test('the positioning map opens anchored on the selected burst window', async () => {
  const openMap = page.getByRole('button', { name: 'Open positioning map' }).first();
  await expect(openMap).toBeVisible();
  await openMap.click();
  await shows(page, 'Positioning');
  await expect(page.locator('wl-map-canvas canvas')).toBeVisible();
  await shows(page, /anchor -?\d+:\d{2}/);
  await shows(page, '● top parses');
  await page.getByRole('button', { name: 'Close map' }).click();
});
