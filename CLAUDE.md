# warcraft-learner

A web-based diagnostic tool for Mythic WoW raiders: it evaluates Warcraft Logs combat data against AI-generated, spec-specific rulebooks and delivers coaching-style feedback benchmarked against top parses. The app is a **fully static Angular SPA** on GitHub Pages - no backend, all analysis client-side, WCL queried directly from the browser with an OAuth2 client-credentials token (no user login).

## How this file works

This file is the always-on **router**: the few rules that apply on every turn, the commands, and a table that tells you which **skill** to load before each kind of work. The detailed conventions live in skills under `.claude/skills/` and load **on demand** - a skill is matched by its `description`, so each task only pulls in the context it needs. Load the matching skill before you start; do not work from memory of a topic that has a skill.

## Always-on rules

- **Never use em-dashes (U+2014), en-dashes (U+2013), the Unicode minus (U+2212), or the middle dot (U+00B7)** anywhere - docs, code comments, commit messages, UI copy, generated output. Use a plain ASCII hyphen (`-`) or rephrase.
- **Describe only current behavior, never past behavior.** Docs, skill files, and code comments state what the code does now - never "previously...", "was removed", "no longer...", or a contrast against a prior approach. Change history lives in git, not in the source.
- **Comment the why, not the what - one terse line, or none.** The default is NO comment. The one gate: a comment may exist only if you can name the specific, concrete mistake a competent reader makes *without* it (feeds this id to a spell lookup; deletes this branch not knowing it handles case Y). If you cannot name that mistake, delete the comment. At most one line, never restating the code, JSDoc included; a why that takes two clauses keeps only the clause naming the mistake. Self-audit every comment your diff adds before committing. When in doubt, delete it.

## Architecture at a glance

Per-use-case **vertical slices** (rotation / burst / defensive / gear / map / live), functional-core / imperative-shell, fed by exactly **two pass-through API services** (`WclApiService`, `DataFileApiService`). Ingestion is the same Angular app booted with the `ingest` configuration, driving the same `*TransformService`s and persisting through a micro file server to `frontend/public/data/specs/**`:

```
INGEST (browser, ingest env)                RUNTIME (browser, Angular)
WclApiService -> *TransformService          data/specs/** -> DataFileApiService
  -> DataFileApiService -> file server            -> *DataSource (token swap)
     (:3000) -> data/specs/**                     -> *FeatureService -> *Component
```

The deployed site is composed on **`gh-pages`** from disjoint single-owner folders: `data/specs/` (shared dataset, written by `ingest-parses`), `main/` (prod shell), `pr-N/` (per-PR shells), and a root `index.html` redirect (all written by `deploy-pages`). Code deploys never re-push data; both writers share one concurrency group. Local dev: `npm run data:pull`.

```
frontend/        # the entire Angular 22 app
  src/app/pages/ # post-raid (/), pre-fight (/pre), the live/ slice
  src/app/core/  # the two API services, data-source token, models
  src/app/ingest # ingest orchestrator (bundled only by the ingest configuration)
  schema/        # wcl.graphql - the introspected WCL v2 SDL, for browsing available fields; gitignored, written by `npm run schema:pull`
  scripts/       # ingest-server.js + ingest-headless.mjs + schema-pull.mjs - plain Node, zero ingestion logic
  e2e/           # Playwright happy-path suite (one WCL analysis per run)
  public/data/specs/  # static ingested data - not tracked on main; lives on gh-pages
.github/workflows/  # deploy-pages, ingest-parses (hourly), test, e2e
.claude/agents/   # rulebook-author.md - the isolated per-spec authoring worker
.claude/skills/   # on-demand skills (see the router below)
```

## Commands (run from `frontend/`)

| Command | Description |
|---|---|
| `npm start` | Angular dev server on http://localhost:4200 |
| `npm run build` | Production build to `../static/angular/` |
| `npm test` | `ng test` (Vitest, the one unit-test suite) |
| `npm run e2e` | Playwright e2e suite over both pages (`npm run data:pull` first) |
| `npm run lint` | `ng lint` over `src/**` then `eslint` over `scripts/**`, `e2e/**`, and the Playwright config |
| `npm run knip` | Dead-code check: unused files, exports, and dependencies (`knip.json`) |
| `npm run schema:pull` | Re-introspect the WCL v2 schema and regenerate `wcl-operations.generated.ts` in one run; commit only the regenerated types |
| `npm run data:pull` | Fetch the shared dataset from `origin/gh-pages` into the ignored working tree |
| `npm run start:ingest` | Interactive ingestion: the file server + `ng serve --configuration ingest` |
| `npm run ingest` | Headless ingestion (CI entry) |

## Development workflow router

Load the matching skill(s) **before** you start that step. The `warcraft-*` skills are this project's rules; Angular/TypeScript conventions are enforced by ESLint (`frontend/eslint.config.js`), not by a skill. A skill loads automatically once its `description` matches the task, or you can name it explicitly - either way, load it before starting the row's work, not from memory.

| When you are... | Load |
|---|---|
| Building or changing any code (finding, rule kind, slice, page, component) | **warcraft-change** |
| Writing or changing any string a user sees | **warcraft-writing** |
| Touching WCL queries, gear / spec / talent / enchant extraction, positions, or `wcl-auth` / the embedded secret | **warcraft-wcl-data** |
| Generating or refreshing a spec's `rulebook.json` | **warcraft-rulebook** |
| Reviewing code, a diff, or a PR | **warcraft-change** (the self-review checklist applies) |
| Verifying a change runs / manual end-to-end check | run the relevant command from the Commands table above |

On any conflict between a skill and this file, **this file wins**.
