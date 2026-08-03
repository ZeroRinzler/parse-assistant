import { expect, test, Page } from '@playwright/test';
import { shows, showsAbility } from './support';

// Figures compared against the top-parse bench are re-pinned from a render dump when the dataset moves (see the warcraft-e2e skill).
const REPORT_URL = 'https://www.warcraftlogs.com/reports/YkVMTyfmFLtXZ1NQ?fight=last';
const PLAYER_NAME = 'Elsahr';
// Mirrors POST_RAID_KEY in core/services/selection-store.ts.
const STICKY_PLAYER_KEY = 'wl.sel.postRaid';

const ANALYZE_TIMEOUT_MS = 120_000;
// The map trails load unawaited after the cards reveal.
const MAP_READY_TIMEOUT_MS = 60_000;
const SLACK_MS = 30_000;

// One shared page: the report is analyzed once, so a run costs one WCL analysis.
test.describe.configure({ mode: 'serial' });

let page: Page;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(ANALYZE_TIMEOUT_MS + SLACK_MS);
  page = await browser.newPage();
  // Seeded before boot so the one analysis targets Elsahr instead of the roster's first player.
  await page.addInitScript(
    ([key, name]) => localStorage.setItem(key, JSON.stringify({ playerName: name })),
    [STICKY_PLAYER_KEY, PLAYER_NAME],
  );
  await page.goto('/');
  await page.getByLabel('Warcraft Logs Report URL or Code').fill(REPORT_URL);
  await page.keyboard.press('Enter');
  // The cards stay hidden until every feature settles, so this one wait covers the whole analysis.
  await expect(page.getByText('Pull overview')).toBeVisible({ timeout: ANALYZE_TIMEOUT_MS });
});

test.afterAll(async () => {
  await page?.close();
});

test('analyzing the report selects the last pull and the sticky player', async () => {
  await expect(page.getByRole('combobox', { name: 'Fight' })).toContainText('Crown of the Cosmos - Kill - 7:34');
  const player = page.getByRole('combobox', { name: 'Player' });
  await expect(player).toContainText(PLAYER_NAME);
  await expect(player.getByAltText('Subtlety Rogue')).toBeVisible();
});

test('pull overview reports the DPS, the death, and the kill', async () => {
  const pullOverview = page.locator('wl-pull-overview');
  await shows(pullOverview, 'Pull 2 - kill.');
  await shows(pullOverview, 'Your DPS');
  // 29,487,085 damage over the 454.4s pull: 64,892 DPS renders as 65K.
  await shows(pullOverview, '65K');
  await shows(pullOverview, '7:34');
  await shows(pullOverview, 'Death 1');
  await shows(pullOverview, 'Bursting Emptiness');
  await shows(pullOverview, '7:33');
  await shows(pullOverview, 'Boss defeated');
});

test('rotation rules count the casts that broke each rulebook rule', async () => {
  const rotationRules = page.locator('wl-finding-table').filter({ hasText: 'Rotation rules vs top parses.' });
  await shows(rotationRules, 'Rotation Rules');
  await shows(rotationRules, 'Low cast efficiency');
  await shows(rotationRules, '60.0%');
  await shows(rotationRules, 'top 64%');
  // A violated rule renders its authored description and type, and counts the casts that broke it.
  await shows(rotationRules, 'Eviscerate at 6 or more combo points');
  await shows(rotationRules, 'rotation');
  await shows(rotationRules, '7 / 87');
  await shows(rotationRules, 'Backstab only below 2 targets');
  await shows(rotationRules, 'aoe');
  await shows(rotationRules, '25 / 55');
  await shows(rotationRules, 'Hold Shadow Dance and Secret Technique for Blades');
  await shows(rotationRules, 'cd hold');
  await shows(rotationRules, 'charge(s)');
});

test('a broken rule renders the rulebook remedy, and a followed one only its name', async () => {
  const rotationRules = page.locator('wl-finding-table').filter({ hasText: 'Rotation rules vs top parses.' });
  // The Fix column is the rule's authored action, carried through the bench file untouched.
  await shows(rotationRules, 'Backstab is your filler on a single target only. From 2 targets up, build with Shuriken Storm instead, and with Shadowstrike while Shadow Dance is up.');
  // A rule the pull kept is a chip under On plan, named exactly as the violated rows name theirs.
  await shows(rotationRules, 'On plan');
  await shows(rotationRules, 'Secret Technique inside Shadow Dance');
  await shows(rotationRules, 'Shadow Blades paired with Shadow Dance');
  await shows(rotationRules, 'Open Shadowstrike into Shadow Dance and Shadow Blades');
});

test('offensives flag the lost cooldown casts and the holds', async () => {
  const offensives = page.locator('wl-finding-table').filter({ hasText: 'Offensive cooldowns vs top parses.' });
  await shows(offensives, 'Shadow Blades');
  await shows(offensives, 'lost cast');
  await shows(offensives, '4 / 5');
  await shows(offensives, 'Vanish');
  await shows(offensives, '3:19');
  await shows(offensives, '+167s');
  await shows(offensives, 'top 00:32');
});

test('burst windows compare the player damage against the top-parse windows', async () => {
  const burstWindows = page.locator('wl-burst-windows');
  await shows(burstWindows, 'Damage in each burst window vs top parses.');
  // The card opens on the player's worst window.
  await shows(burstWindows, 'window');
  await shows(burstWindows, '3:22 - 3:26');
  await shows(burstWindows, 'burst');
  await shows(burstWindows, '2K');
  await shows(burstWindows, '-100%');
  await showsAbility(burstWindows, 'Secret Technique', '494K');
  await shows(burstWindows, 'missed');
  await shows(burstWindows, '0 / 1');
});

test('defensives stay on plan and benchmark the damage taken', async () => {
  const defensives = page.locator('wl-defensive');
  await shows(defensives, 'Defensive cooldowns vs top parses.');
  await shows(defensives, 'On plan');
  await shows(defensives, 'Feint');
  await shows(defensives, 'Crimson Vial');
  await shows(defensives, 'Cloak of Shadows');
  await shows(defensives, 'Damage taken in top-parse defensive windows vs top parses.');
  await shows(defensives, '0:58 - 1:04');
  await shows(defensives, '552K');
  await shows(defensives, '+175%');
});

test('gear lists the top-parse talent builds, trinkets, and enchants', async () => {
  const gear = page.locator('wl-gear');
  await shows(gear, 'Gear vs top parses.');
  await shows(gear, 'Talents');
  await shows(gear, 'Your build');
  // The talent builds are listed in the post-raid card, most common first: 40% / 30% / 30%.
  await shows(gear, 'Most common build');
  await shows(gear, '40%');
  await shows(gear, 'Alt build 1');
  await shows(gear, 'Alt build 2');
  await shows(gear, 'of top parsers');
  await shows(gear, 'Trinkets');
  await shows(gear, 'Light Company Guidon');
  await shows(gear, 'Gaze of the Alnseer');
  await shows(gear, 'Enchants');
  await shows(gear, 'All enchants');
});

test('the positioning map opens anchored on the death', async () => {
  test.setTimeout(MAP_READY_TIMEOUT_MS + SLACK_MS);
  // The first map button belongs to the pull overview's death row.
  const openMap = page.getByRole('button', { name: 'Open positioning map' }).first();
  await expect(openMap).toBeVisible({ timeout: MAP_READY_TIMEOUT_MS });
  await openMap.click();
  await shows(page, 'Positioning');
  await expect(page.locator('wl-map-canvas canvas')).toBeVisible();
  await shows(page, 'anchor 7:33');
  await shows(page, '● top parses');
  // The gold marker renders only once the player's own trail has loaded.
  await expect(page.getByText('◆ you')).toBeVisible({ timeout: MAP_READY_TIMEOUT_MS });
  await page.getByRole('button', { name: 'Close map' }).click();
});
