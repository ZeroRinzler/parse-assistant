# warcraft-learner

A web-based diagnostic tool for Mythic WoW raiders: it evaluates Warcraft Logs combat data against AI-generated, spec-specific rulebooks and delivers coaching-style feedback benchmarked against top parses. The app is a **fully static Angular SPA** on GitHub Pages - no backend, all analysis client-side, WCL queried directly from the browser with an OAuth2 client-credentials token (no user login).

## How this file works

This file is the always-on **router**: the few rules that apply on every turn, plus a table that tells you which **skill** to load before each kind of work. The detailed conventions (frontend, architecture, testing, ingestion, WCL/data, copy/branding) live in skills under `.claude/skills/` and load **on demand** - so each task only pulls in the context it needs. Load the matching skill before you start; do not work from memory of a topic that has a skill.

## Always-on rules

- **Never use em-dashes (U+2014) or en-dashes (U+2013)** anywhere - not in docs, code comments, commit messages, UI copy, or generated output. Also avoid the Unicode minus (U+2212). Use a plain ASCII hyphen (`-`) for ranges and parenthetical asides, or rephrase. This applies to every file in the repo and any text the tooling emits.
- **Describe only current behavior, never past behavior.** Documentation, skill files, and code comments MUST describe what the code does now, not what it used to do, what was removed, or how it changed. Never write "the old code...", "previously...", "was removed", "no longer...", "used to...", or contrast against a prior approach ("X instead of the old Y", "not the absolute-clock target anymore"). Describing what is no longer there is noise. State the current behavior directly; the change history lives in git, commit messages, and PR descriptions, not in the source or docs.
- **Comment the why, not the what - one terse line, or none. This is a hard limit, not a guideline.** The default is NO comment; the existing files in this repo are comment-heavy and you must NOT mirror that style. A comment earns its place only by stating what the code cannot: a reason, a constraint, a non-obvious consequence, a source link. The hard rules: (1) **The mistake test - the one gate that decides every comment.** A comment may exist only if you can name the specific, concrete mistake a competent reader makes *without* it (feeds this id to a spell lookup; keys the map by the wrong field and reintroduces bug X; deletes this branch not knowing it handles case Y). If you cannot name that mistake in one sentence, the comment is describing what the code does - **delete it.** "Summarizes the function", "documents the field", "explains the type", and "adds context" are NOT mistakes prevented; they are restating code. A well-named symbol needs no summary. (2) **At most one line.** Never a multi-line comment block and never a paragraph; if a comment needs a second line, cut it or delete it. (3) **Never restate the code.** If the comment paraphrases what the next statement plainly says, delete it (no `// re-scan the document` above `refreshLinks()`). (4) **Rules (1)-(3) apply to JSDoc / `/** */` summaries exactly as to `//` comments** - a one-line `/** Does X. */` over a function named doX is a restatement; delete it. **Mandatory self-audit before every commit:** list every comment line your diff adds or changes, and for each one either state the concrete mistake it prevents or delete it. Ship none you cannot justify. When in doubt, delete it.

(These rules stay here because they govern all output, not just one kind of work - everything else is in a skill.)

## Architecture at a glance

The app is built as **per-use-case vertical slices** (rotation / burst / defensive / gear / map / live), functional-core / imperative-shell, fed by exactly **two pass-through API services** at runtime (`WclApiService`, `DataFileApiService`). Two symmetric pipelines meet at the static data files in `frontend/public/data/specs/**`. The `live` slice (`pages/post-raid/live/`) is the exception to the data pipeline: it owns the live-sync + screen-recording toggles and the per-window clip replay (a `getDisplayMedia` rolling buffer; clips are cut from it and memoized in memory), so it reads no bench data and keeps all footage in the browser session.

```
INGEST (browser, ingest environment)        RUNTIME (browser, Angular)
WclApiService -> *TransformService          data/specs/**  ->  DataFileApiService
  -> DataFileApiService -> file server                         -> *DataSource (token swap)
     (:3000) -> data/specs/**                                  -> *FeatureService -> *Component
                                                               -> page shell -> leaves
```

Ingestion is the **same Angular app** booted with the `ingest` build configuration: an app initializer runs `IngestOrchestratorService` (`src/app/ingest/`), which drives the same `*TransformService`s the runtime uses and persists through a micro file server (`scripts/ingest-server.js`, a dumb save/delete/list/load store over `public/data/`). The full directory map, the hard layer rules, and the data-flow diagram are in the **warcraft-architecture** skill.

```
frontend/        # the entire Angular 22 app
  src/app/pages/ # post-raid (/, incl. the live/ slice: live-sync + recording toggles, clip replay), pre-fight (/pre)
  src/app/core/  # the two API services, data-source token, models
  src/app/ingest # ingest orchestrator + discovery helpers (bundled only by the ingest configuration)
  scripts/       # ingest-server.js (file store) + ingest-headless.mjs (CI harness) - plain Node, zero ingestion logic
  e2e/           # Playwright happy-path suite for both pages (one WCL analysis per run - see warcraft-e2e)
  public/data/specs/  # static ingested data (slices, encounters, positions, rulebooks) - NOT tracked on main; see below
.github/workflows/  # deploy-pages (shell + PR previews), ingest-parses (hourly), test
.claude/skills/   # on-demand skills (rulebook schema in warcraft-ingestion/, generation in warcraft-rulebook/)
```

The ~100 MB of minified bench data under `frontend/public/data/specs/**` is **not tracked on `main`** (gitignored). The deployed site is composed on **`gh-pages`** from disjoint single-owner folders at the site root: `data/specs/` (shared dataset, written by `ingest-parses`), and `main/` (prod shell), `pr-N/` (per-PR shells) plus a root `index.html` redirecting to `/main/` (all written by `deploy-pages`). Every environment ships only the shell and reads the one shared dataset via an absolute `dataBaseHref`, so code deploys never re-push data. Both writers share one `gh-pages` concurrency group (serialized single-commit force-pushes). Each `deploy-pages` run replaces only the folders its trigger owns in a gh-pages worktree - push: the shell + root files; PR events / dispatch: the root `pr-*` dirs wholesale, rebuilt from all open PRs - so closed previews vanish structurally (no cleanup workflow). Local dev: `npm run data:pull` (from `frontend/`) fetches the data from `origin/gh-pages`.

## Commands (run from `frontend/`)

| Command | Description |
|---|---|
| `npm start` | Angular dev server on http://localhost:4200 |
| `npm run build` | Production build to `../static/angular/` |
| `npm test` | `ng test` (Vitest, the one unit-test suite) |
| `npm run e2e` | Playwright e2e suite over both pages (`npm run data:pull` first; a run spends one WCL analysis - see the warcraft-e2e skill) |
| `npm run lint` | `ng lint` over `src/**` then `eslint` over `scripts/**`, `e2e/**`, and the Playwright config |
| `npm run start:ingest` | Interactive ingestion: the file server + `ng serve --configuration ingest` (open :4200, watch the console) |
| `npm run ingest` | Headless ingestion (CI entry): drives the ingest app in headless Chromium, exits on completion |

## Development workflow router

Load the matching skill(s) **before** you start that step. The `warcraft-*` skills are this project's rules; `angular-developer` and `solid` are generic references (project rules win on conflict); `/code-review`, `/simplify`, `/verify`, `/run` are built-in skills.

| When you are... | Load before you start |
|---|---|
| Planning / scoping any change | the `Plan` agent + **warcraft-architecture** (+ the domain skill for the area) |
| Designing / building Angular UI (components, templates, styling, pipes, services) | **angular-developer** + **warcraft-frontend** |
| Writing user-facing copy, findings, microcopy, or anything branded (titles, nav, banners, READMEs, favicon) | **warcraft-copy** |
| Working on a vertical slice, a transform, analysis math, or layer boundaries | **warcraft-architecture** |
| Touching WCL queries, gear / spec / talent / enchant extraction, positions, or `wcl-auth` / the embedded secret | **warcraft-wcl-data** |
| Working on the live slice (live-sync, screen recording, the clip replay flyover) | **warcraft-frontend** + **warcraft-architecture** |
| Generating or refreshing a spec's `rulebook.json` (one, some, or all specs) | **warcraft-rulebook** |
| Ingestion (`src/app/ingest/**`, the `scripts/` file server + harness), `data/specs` file shapes, rulebook consumption/schema, or `INGEST_VERSION` | **warcraft-ingestion** |
| Writing or changing unit tests (`src/**/*.spec.ts`) or the test setup | **warcraft-testing** |
| Writing or changing e2e tests (`frontend/e2e/**`, `playwright.config.ts`, the e2e workflow) | **warcraft-e2e** |
| General refactor / code-quality cleanup | **solid** + `/simplify` (project rules win on conflict) |
| Reviewing code, a diff, or a PR | `/code-review` + **solid** + the domain skill(s) for the changed area |
| Verifying a change runs / manual end-to-end check | `/verify` or `/run` |

On any conflict between a skill and this file, or between a generic skill (`angular-developer`, `solid`) and a `warcraft-*` project skill, the **project skill / this file wins**.
