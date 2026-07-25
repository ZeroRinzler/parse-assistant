---
name: warcraft-e2e
description: warcraft-learner Playwright e2e suite and the WCL-budget rules it obeys. Covers the setup (frontend/playwright.config.ts, specs under frontend/e2e/, the production-configuration webServer, the data:pull prerequisite), the one-load-per-page discipline (serial mode on one shared page, zero retries, the sticky-player localStorage seed, bench-only pre-fight), the rule that every test pins a real computed value plus its static copy, how to re-pin from a render dump, the textContent matching quirks, and the CI workflow. Load this before writing, changing, or debugging anything under frontend/e2e/**, playwright.config.ts, or .github/workflows/e2e.yml.
---

# warcraft-learner e2e testing

The e2e suite drives the built app in a real Chromium against live WCL and the pulled dataset. Assertions read like statements of the page's behavior, under one constraint that shapes everything: **a run must spend at most one WCL analysis**.

**Framework and layout.** [Playwright Test](https://playwright.dev) (`@playwright/test`, pinned to the `playwright` version the ingest harness uses). Config in `frontend/playwright.config.ts`; specs in `frontend/e2e/` - one per page (`post-raid.spec.ts`, `pre-fight.spec.ts`), shared assertion helpers in `support.ts`, `tsconfig.json` for types. `npm run e2e` runs it, `npm run lint` covers it. Playwright's `webServer` starts `npm start -- --configuration production` on :4200 itself; locally an already-running server there is reused.

**Production configuration (hard rule).** The suite serves the `production` build so every slice reads its ingested file. Never point it at `development`: it binds each slice to its `*TransformService`, which recomputes every bench from the top parses in the browser and drains the shared budget.

**Dataset prerequisite.** Run `npm run data:pull` first. The config refuses to start without `public/data/specs/index.json`, so a missing dataset fails with that hint rather than as empty-bench cards.

**One load per page (hard rules).**

- Each spec sets `test.describe.configure({ mode: 'serial' })` over **one shared `page`** built in `beforeAll`, loaded and analyzed exactly once there. Never `goto` or re-analyze inside a test.
- `retries` stays `0`: a retry re-runs the whole serial chain, spending a second analysis on an already-failing run.
- The post-raid `beforeAll` seeds the sticky player name into localStorage before the app boots, so the one analysis targets the test character. Without it the shell picks the roster's first player, and correcting that costs a second analysis.
- `pre-fight.spec.ts` is bench-only and spends nothing, so it exercises the real class/spec/encounter dropdowns.
- `.github/workflows/e2e.yml` runs on pull requests, pushes to `main`, and on demand, reporting into the PR checks next to the unit tests. Its `cancel-in-progress` concurrency group keyed on the ref keeps a re-push from spending a second analysis on a stale commit.

**Every test asserts static copy AND at least one computed value (hard rule).** A test that only checks headings and "some row exists" passes on an empty card, so it proves nothing. Pin the exact rendered figures next to the labels around them: the 65K DPS, the 356K killing blow, `1 / 20` Secret Technique casts outside Shadow Dance, the 121s Feint gap, the 507K taken in the 0:58 defensive window, the 15.6M bench opener. The map tests pin the anchor the flyover opened at (`anchor 7:33`, `anchor 0:08`) so the canvas is proven to show the right moment.

**Two tiers of pinned value.** Figures off the player's own log (DPS, deaths, cast counts, their gear) are fixed - the report is finished. Figures from or against the top-parse bench (findings, window boundaries and damage, consensus percentages, plan first-use/avg-uses) move when the ingested dataset changes, so a bench refresh can legitimately turn a run red; a stale pin is a one-line fix. To re-pin, dump what the app renders rather than guessing: a temporary spec that loads the page and `writeFileSync`s each card's `innerText` (specs run in Node), then read the strings out and delete it.

**Locators.** Inline the on-screen copy in the assertion - the literal text is the documentation. Constants are for opaque values only (report URL, storage key, timeouts). A card's scope is its `wl-*` tag; inside it prefer `getByRole` / `getByLabel` / `getByText` / `getByAltText` over CSS.

**Matching quirks.** Playwright matches `textContent`, so assert a CSS-`uppercase` label in its template casing (`'window'`, `'burst'`, `'measured'`). `shows` matches a string as whole-element text (`exact`, whitespace-normalized) and takes the first hit, so multi-node interpolations like `'6:37 - 6:41'` work and a repeated stat never trips strict mode. Whole-element matching fails on a cell carrying a responsive `md:hidden` label, since the hidden text is still in `textContent`; scope to the row and assert containment, as `showsAbility` does. A regex matches raw text including template newlines, so anchor one only when the interpolation is the element's entire content.

**Scope.** One test per use-case card, happy path only. Post-raid: selection, pull overview, rotation, burst windows, defensive windows, gear, map. Pre-fight: selection, gear consensus, cooldown plan, defensive plan, burst windows, map. The live slice is not covered: it needs a `getDisplayMedia` capture the harness cannot grant meaningfully.

**Timeouts.** The post-raid reveal gate holds every card hidden until all settle, so one visibility wait covers the whole analysis (`ANALYZE_TIMEOUT_MS`); the map loads unawaited afterwards (`MAP_READY_TIMEOUT_MS`). A test waiting past Playwright's default calls `test.setTimeout()` with those plus `SLACK_MS`.

**Local launch tweaks stay local.** Proxies, CA handling, or a pinned Chromium `executablePath` never go in the committed config. Put them in an untracked file extending it (`defineConfig(base, { use: { ... } })`) and run `npx playwright test --config=<that file>`.
