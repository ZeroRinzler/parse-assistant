import { expect, test, Page } from '@playwright/test';
import { shows, DAMAGE } from './support';

// Reuses post-raid.spec's fixture report for both sides (two different players, one pull) to spend minimal extra WCL budget.
const REPORT_URL = 'https://www.warcraftlogs.com/reports/fGDk8PmvBzdhtQga?fight=last';

const ANALYZE_TIMEOUT_MS = 30_000;

test.describe.configure({ mode: 'serial' });

let page: Page;

function picker(label: string) {
  return page.locator('wl-report-picker').filter({ hasText: label });
}

async function loadSide(label: string): Promise<void> {
  const side = picker(label);
  await side.getByLabel('Warcraft Logs Report URL or Code').fill(REPORT_URL);
  await side.getByRole('button', { name: 'Load report' }).click();
  const pull = side.getByRole('combobox', { name: 'Pull' });
  await expect(pull).toContainText("Nek'zali the Soulcoiler", { timeout: ANALYZE_TIMEOUT_MS });
  await expect(pull).toContainText('Kill');
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(ANALYZE_TIMEOUT_MS * 2);
  page = await browser.newPage();
  await page.goto('/compare');
  await loadSide('Log A');
  await loadSide('Log B');
});

test.afterAll(async () => {
  await page.close();
});

test('loading both sides on the same pull enables Compare', async () => {
  await expect(picker('Log A').getByRole('combobox', { name: 'Player' })).toBeVisible();
  await expect(picker('Log B').getByRole('combobox', { name: 'Player' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Compare' })).toBeEnabled();
});

test('comparing renders a sorted ability breakdown between two different players', async () => {
  // Both sides default to the same player; picking a different one on B is what makes the diff meaningful.
  await picker('Log B').getByRole('combobox', { name: 'Player' }).click();
  await page.getByRole('option').nth(1).click();

  await page.getByRole('button', { name: 'Compare' }).click();

  const table = page.locator('wl-ability-diff-table');
  await shows(table, 'vs');
  await shows(table, 'ability');
  await shows(table, 'delta');
  await shows(table, DAMAGE);
});

test('comparing two logs on the same spec renders the full Analyze card set', async () => {
  // Same spec on both sides (here: the same player), which is what unlocks the detailed cards below the ability table.
  const playerAName = (await picker('Log A').getByRole('combobox', { name: 'Player' }).innerText()).trim();
  const playerBCombo = picker('Log B').getByRole('combobox', { name: 'Player' });
  await playerBCombo.click();
  await page.getByRole('option', { name: playerAName }).click();

  await page.getByRole('button', { name: 'Compare' }).click();

  await expect(page.locator('wl-pull-overview')).toHaveCount(2, { timeout: ANALYZE_TIMEOUT_MS });
  await expect(page.locator('wl-rotation')).toBeVisible();
  const burst = page.locator('wl-burst-windows');
  await expect(burst).toBeVisible();
  await expect(page.locator('wl-defensive')).toBeVisible();
  await expect(page.locator('wl-gear')).toBeVisible();

  // The peer's own name replaces "top parses" wording in compare mode - both sides share one player here.
  const peerName = playerAName.split(' (')[0] ?? playerAName;
  await expect(burst).toContainText(peerName);
  await expect(burst).not.toContainText('top parses');
  await expect(burst).not.toContainText('top average');
});
