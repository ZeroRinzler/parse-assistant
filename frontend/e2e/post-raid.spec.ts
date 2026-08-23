import { expect, test, Page } from '@playwright/test';
import {
  findingRows, shows, showsEntity, showsFindingRows, showsOnPlan, CD_CHIP, CLOCK, DAMAGE, PERCENT, RATIO,
} from './support';

const REPORT_URL = 'https://www.warcraftlogs.com/reports/fGDk8PmvBzdhtQga?fight=last';
const PLAYER_NAME = 'Pudders';
// Mirrors POST_RAID_KEY in core/services/selection-store.ts.
const STICKY_PLAYER_KEY = 'wl.sel.postRaid';

// Mirrors POLL_INTERVAL_S in core/services/live-report-sync.ts.
const POLL_INTERVAL_S = 12;

const ANALYZE_TIMEOUT_MS = 120_000;
// The map trails load unawaited after the cards reveal.
const MAP_READY_TIMEOUT_MS = 60_000;
const LIVE_TIMEOUT_MS = 15_000;
const SLACK_MS = 30_000;

// One shared page: the report is analyzed once, so a run costs one WCL analysis.
test.describe.configure({ mode: 'serial' });

let page: Page;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(ANALYZE_TIMEOUT_MS + SLACK_MS);
  page = await browser.newPage();
  // Seeded before boot so the one analysis targets Pudders instead of the roster's first player.
  await page.addInitScript(
    ([key, name]) => { localStorage.setItem(key, JSON.stringify({ playerName: name })); },
    [STICKY_PLAYER_KEY, PLAYER_NAME] as const,
  );
  await page.goto('/');
  await page.getByLabel('Warcraft Logs Report URL or Code').fill(REPORT_URL);
  await page.keyboard.press('Enter');
  // The cards stay hidden until every feature settles, so this one wait covers the whole analysis.
  await expect(page.getByText('Pull overview')).toBeVisible({ timeout: ANALYZE_TIMEOUT_MS });
});

test.afterAll(async () => {
  await page.close();
});

test('analyzing the report selects the last pull and the sticky player', async () => {
  const fight = page.getByRole('combobox', { name: 'Fight' });
  await expect(fight).toContainText("Nek'zali the Soulcoiler");
  await expect(fight).toContainText('Kill');
  await expect(fight).toContainText(CLOCK);
  const player = page.getByRole('combobox', { name: 'Player' });
  await expect(player).toContainText(PLAYER_NAME);
  await expect(player.getByAltText('Balance Druid')).toBeVisible();
});

test('following the latest pull hands the fight selection to the live poll', async () => {
  const controls = page.locator('wl-live-controls');
  const follow = controls.getByRole('switch', { name: 'Follow latest pull' });
  const fight = page.getByRole('combobox', { name: 'Fight' });

  await follow.click();
  await expect(follow).toBeChecked();
  await expect(fight).toHaveAttribute('aria-disabled', 'true');
  // The poll stamps its own clock time, so only the interval beside it is pinned.
  const settled = new RegExp(`Last updated .+, polling every ${POLL_INTERVAL_S}s`);
  await expect(controls.getByText(settled)).toBeVisible({ timeout: LIVE_TIMEOUT_MS });

  // Left on, the poll keeps hitting Warcraft Logs under every later test.
  await follow.click();
  await expect(fight).toHaveAttribute('aria-disabled', 'false');
  await expect(controls.getByText(settled)).toHaveCount(0);
});

test('recording the game client captures a named display source', async () => {
  const controls = page.locator('wl-live-controls');
  const record = controls.getByRole('switch', { name: 'Record game client' });

  await record.click();
  await expect(record).toBeChecked();
  // The picked display source names itself, so only the copy around the name is pinned.
  await expect(controls.getByText(/^Recording ".+" in the background$/)).toBeVisible({ timeout: LIVE_TIMEOUT_MS });

  await record.click();
  await expect(record).not.toBeChecked();
  await shows(controls, 'stays in this browser session, nothing is uploaded');
});

test('pull overview reports the DPS, the death, and the kill', async () => {
  const pullOverview = page.locator('wl-pull-overview');
  await shows(pullOverview, /Pull \d+ - kill\./);
  await shows(pullOverview, 'Your DPS');
  await shows(pullOverview, DAMAGE);
  await shows(pullOverview, /Death \d+/);
  const deathRow = pullOverview.locator('div.grid', { hasText: /Death \d+/ }).first();
  await expect(deathRow.locator('span.font-mono')).toHaveText(CLOCK);
  const outcomeRow = pullOverview.locator('div.grid', { hasText: 'Boss defeated' }).first();
  await expect(outcomeRow).toContainText('Kill');
  await expect(outcomeRow.locator('span.font-mono')).toHaveText(CLOCK);
});

test('rotation rules count the casts that broke each rulebook rule, and name the ones followed', async () => {
  const rotationRules = page.locator('wl-finding-table').filter({ hasText: 'Rotation rules vs top parses.' });
  await shows(rotationRules, 'Rotation Rules');
  await showsFindingRows(rotationRules);
  // A rule the pull followed shows as a chip rather than a row, so only both together cover the rulebook.
  await showsOnPlan(rotationRules);
});

test('a rule row expands into a chip strip of the instances behind its count', async () => {
  const rotationRules = page.locator('wl-finding-table').filter({ hasText: 'Rotation rules vs top parses.' });
  // The button's accessible name flips to "Hide instances" once clicked, so the filter matches either name.
  const row = findingRows(rotationRules)
    .filter({ has: page.getByRole('button', { name: /instances/i }) }).first();
  await row.getByRole('button', { name: 'Show instances' }).click();
  const strip = row.locator('wl-finding-occurrences');
  await expect(strip).toBeVisible();
  // MAX_OCCURRENCES is a code constant (24), not a bench value - the sampler caps the strip at it however many casts judged the row.
  const count = await strip.getByRole('option').count();
  expect(count).toBeGreaterThan(0);
  expect(count).toBeLessThanOrEqual(24);
  await row.getByRole('button', { name: 'Hide instances' }).click();
  await expect(strip).not.toBeVisible();
});

test('offensives flag the cooldown casts that missed the top-parse plan', async () => {
  const offensives = page.locator('wl-finding-table').filter({ hasText: 'Offensive cooldowns vs top parses.' });
  await showsEntity(offensives);
  await showsFindingRows(offensives, CD_CHIP);
});

test('burst windows compare the player damage against the top-parse windows', async () => {
  const burstWindows = page.locator('wl-burst-windows');
  await shows(burstWindows, 'Damage in each burst window vs top parses.');
  await shows(burstWindows, 'window');
  await shows(burstWindows, /\d+:\d{2} - \d+:\d{2}/);
  await shows(burstWindows, 'burst');
  await shows(burstWindows, DAMAGE);
  await shows(burstWindows, PERCENT);
  await showsEntity(burstWindows);
  // A pull can land every top-parse ability, so a row is pinned to the cast count it carries either way.
  const abilities = burstWindows.locator('wl-compact-ability-row');
  const count = await abilities.count();
  expect(count).toBeGreaterThan(0);
  for (let i = 0; i < count; i++) {
    await expect(abilities.nth(i)).toHaveText(new RegExp(`${RATIO.source}|passive`));
  }
});

test('defensives flag the mistimed cooldowns and benchmark the damage taken', async () => {
  const defensives = page.locator('wl-defensive');
  await shows(defensives, 'Defensive cooldowns vs top parses.');
  const table = defensives.locator('wl-finding-table');
  await showsFindingRows(table, CD_CHIP);
  await showsOnPlan(table);
  await shows(defensives, 'Damage taken in top-parse defensive windows vs top parses.');
  await shows(defensives, /\d+:\d{2} - \d+:\d{2}/);
  await shows(defensives, DAMAGE);
  await shows(defensives, PERCENT);
});

test('gear lists the top-parse talent builds and how the alt build differs, plus trinkets and enchants', async () => {
  const gear = page.locator('wl-gear');
  await shows(gear, 'Gear vs top parses.');
  const talents = gear.locator('div.border-t').filter({ hasText: 'Talents' }).first();
  await shows(talents, 'Your build');
  await shows(talents, /Most common build/);
  await shows(talents, PERCENT);
  await shows(talents, 'of top parsers');
  // How many alt builds the bench carries moves with every refresh; a thin sample can leave zero.
  if (await talents.getByText(/Alt build \d+/).count()) {
    await shows(talents, /Alt build 1/);
    await shows(talents, 'Added');
    await shows(talents, 'Dropped');
    await showsEntity(talents);
  }
  const trinkets = gear.locator('div.border-t').filter({ hasText: 'Trinkets' }).first();
  await expect(trinkets.locator('a[href*="wowhead.com/item="]').first()).toBeVisible();
  const enchants = gear.locator('div.border-t').filter({ hasText: 'Enchants' }).first();
  // The enchant verdict moves with the bench: issue rows, the on-plan strip, or no data at all.
  await expect(enchants.locator('wl-collapsible-text').first()
    .or(enchants.getByText('On plan').first())
    .or(enchants.getByText('No enchant data.').first())
    .first()).toBeVisible();
});

test('the positioning map opens anchored on the death', async () => {
  test.setTimeout(MAP_READY_TIMEOUT_MS + SLACK_MS);
  // The first map button belongs to the pull overview's death row.
  const openMap = page.getByRole('button', { name: 'Open positioning map' }).first();
  await expect(openMap).toBeVisible({ timeout: MAP_READY_TIMEOUT_MS });
  await openMap.click();
  await shows(page, 'Positioning');
  await expect(page.locator('wl-map-canvas canvas')).toBeVisible();
  await shows(page, /anchor -?\d+:\d{2}/);
  await shows(page, '● top parses');
  // The gold marker renders only once the player's own trail has loaded.
  await expect(page.getByText('◆ you')).toBeVisible({ timeout: MAP_READY_TIMEOUT_MS });
  await page.getByRole('button', { name: 'Close map' }).click();
});
