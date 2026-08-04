---
name: warcraft-e2e
description: warcraft-learner Playwright e2e suite and the WCL-budget rules it obeys. Covers the setup (frontend/playwright.config.ts, specs under frontend/e2e/, the production-configuration webServer, the data:pull prerequisite), the one-load-per-page discipline (serial mode on one shared page, zero retries, the sticky-player localStorage seed, bench-only pre-fight), the rule that every test asserts static copy exactly and any computed value only by shape or existence (never a pinned number, name, or timestamp), the shared shape helpers in support.ts, the textContent matching quirks, and the CI workflow. Load this before writing, changing, or debugging anything under frontend/e2e/**, playwright.config.ts, or .github/workflows/e2e.yml.
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

**Every test asserts static copy exactly and any computed value only by shape or existence (hard rule).** A test that only checks headings and "some row exists" passes on an empty card, so every test still proves a real figure rendered - but the figure itself is never the pinned thing. Both the player's own log (DPS, deaths, cast counts, their gear) and the top-parse bench (findings, window boundaries and damage, consensus percentages, plan first-use/avg-uses, which ability or item the bench ranks first) produce numbers and names that change from one run, log, or ingested dataset to the next without any feature having regressed. So:

- Static UI copy - headings, subtitles, section labels, category chips the app itself defines (`rotation` / `aoe` / `cd hold`, `lost cast` / `held`, `On plan`, `window`, `burst`, `missed`) - is asserted with the exact literal string, via `shows`.
- Every computed value - DPS, timestamps, percentages, cast ratios, damage figures, an ability/gear/trinket/enchant name the bench ranked first, rulebook remedy text - is asserted only by shape (one of the regexes in `support.ts`: `DAMAGE`, `CLOCK`, `PERCENT`, `RATIO`, `DECIMAL`) or by existence (`showsEntity` asserts a named row rendered a real `wl-game-icon` without caring which ability it names; `not.toHaveText('')` asserts a remedy/fix cell is non-empty without pinning its sentence). The map tests pin the anchor's *format* (`/anchor -?\d+:\d{2}/`), proving the canvas opened on a real moment without pinning which moment.
- A finding/gear row selected by bench ranking (which ability broke a rule, which build is the alt build, which trinket is flagged) is found generically - `.first()`, or filtered only by a static category chip / section label, never by the specific name it happens to carry this run.

Because no test pins a rendered figure, an ingestion refresh, a rulebook regen, or the log simply differing from run to run never turns the suite red by itself - only an actual rendering regression does. There is nothing to re-pin from a render dump.

**Locators.** Inline the on-screen copy in the assertion for static labels - the literal text is the documentation. For a computed value, locate the structural cell instead (a card's `wl-*` tag, a `div.border-t` row, a `.chip-onplan` chip) and assert its shape or that a `wl-game-icon` rendered inside it (`showsEntity`) - never the label the row happens to carry. Constants are for opaque values (report URL, storage key, timeouts) and the shared shape regexes in `support.ts`. A card's scope is its `wl-*` tag; inside it prefer `getByRole` / `getByLabel` / `getByText` / `getByAltText` over CSS, falling back to a structural class (`div.border-t`, `.chip-onplan`) only to scope a row whose content is not pinned.

**Matching quirks.** Playwright matches `textContent`, so assert a CSS-`uppercase` label in its template casing (`'window'`, `'burst'`, `'measured'`). `shows` matches a string as whole-element text (`exact`, whitespace-normalized) and takes the first hit, so a static label never trips strict mode even when it repeats. A shape regex spans multi-node interpolations the same way a pinned string would - a window's time range renders as start/dash/end across separate nodes, and `/\d+:\d{2} - \d+:\d{2}/` matches the combined text without needing to know the times. Whole-element matching fails on a cell carrying a responsive `md:hidden` label, since the hidden text is still in `textContent`; scope to the row and assert containment there instead, as the `div.border-t` filters do. A regex matches raw text including template newlines and matches anywhere in the element (no anchoring needed to find a shape inside a larger cell); `.filter({ hasText })` on a structural class returns outer matches before inner ones, so `.first()` reliably picks the whole row rather than a nested leaf.

**Scope.** One test per use-case card, happy path only. Post-raid: selection, pull overview, rotation, burst windows, defensive windows, gear, map. Pre-fight: selection, gear consensus, cooldown plan, defensive plan, burst windows, map. The live slice is not covered: it needs a `getDisplayMedia` capture the harness cannot grant meaningfully.

**Timeouts.** The post-raid reveal gate holds every card hidden until all settle, so one visibility wait covers the whole analysis (`ANALYZE_TIMEOUT_MS`); the map loads unawaited afterwards (`MAP_READY_TIMEOUT_MS`). A test waiting past Playwright's default calls `test.setTimeout()` with those plus `SLACK_MS`.

**Local launch tweaks stay local.** Proxies, CA handling, or a pinned Chromium `executablePath` never go in the committed config. Put them in an untracked file extending it (`defineConfig(base, { use: { ... } })`) and run `npx playwright test --config=<that file>`.
