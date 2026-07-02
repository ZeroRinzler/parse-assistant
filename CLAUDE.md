# warcraft-learner

A web-based diagnostic tool for Mythic WoW raiders: it evaluates Warcraft Logs combat data against AI-generated, spec-specific rulebooks and delivers coaching-style feedback benchmarked against top parses. The app is a **fully static Angular SPA** on GitHub Pages - no backend, all analysis client-side, WCL queried directly from the browser with an OAuth2 client-credentials token (no user login).

## How this file works

This file is the always-on **router**: the few rules that apply on every turn, plus a table that tells you which **skill** to load before each kind of work. The detailed conventions (frontend, architecture, testing, ingestion, WCL/data, copy/branding) live in skills under `.claude/skills/` and load **on demand** - so each task only pulls in the context it needs. Load the matching skill before you start; do not work from memory of a topic that has a skill.

## Always-on rule

- **Never use em-dashes (U+2014) or en-dashes (U+2013)** anywhere - not in docs, code comments, commit messages, UI copy, or generated output. Also avoid the Unicode minus (U+2212). Use a plain ASCII hyphen (`-`) for ranges and parenthetical asides, or rephrase. This applies to every file in the repo and any text the tooling emits. (This one rule stays here because it governs all output, not just one kind of work - everything else is in a skill.)

## Architecture at a glance

The app is built as **per-use-case vertical slices** (rotation / burst / defensive / gear / map), functional-core / imperative-shell, fed by exactly **two pass-through API services** at runtime (`WclApiService`, `DataFileApiService`). Two symmetric pipelines meet at the static data files in `frontend/public/data/specs/**`:

```
INGEST (Node, scripts/ingest)            RUNTIME (browser, Angular)
WclApi -> *TransformService -> DataFileApi  ->  data/specs/**  ->  DataFileApiService
                                                                   -> *DataSource (token swap)
                                                                   -> *FeatureService -> *Component
                                                                   -> page shell -> leaves
```

Ingestion runs the **same** `*TransformService`s the browser uses, headlessly. The full directory map, the hard layer rules, and the data-flow diagram are in the **warcraft-architecture** skill.

```
frontend/        # the entire Angular 22 app
  src/app/pages/ # post-raid (/), pre-fight (/pre), live (/live)
  src/app/core/  # the two API services, data-source token, models
  scripts/ingest # ingestion orchestrator + discovery helpers (run via tsx)
  public/data/specs/  # static ingested data (slices, encounters, positions, rulebooks) - NOT tracked on main; see below
.github/workflows/  # deploy-pages, ingest-parses (hourly), pr-preview, test
.claude/skills/   # on-demand skills (incl. the rulebook LLM prompt + schema in warcraft-ingestion/)
```

The ~400 MB of generated bench data under `frontend/public/data/specs/**` is **not tracked on `main`** (it is gitignored there). It lives on a dedicated, **always-squashed `data` branch**: a single orphan commit force-pushed on every hourly ingest, so `main` history never grows with multi-MB JSON churn. The `deploy-pages` workflow overlays that snapshot into the prod build at the site root; `ingest-parses` overlays it, re-ingests, and force-pushes the new snapshot back to `data`. `pr-preview` ships **no** data of its own - the data is identical across prod and every preview, so preview builds fetch the single shared prod-root copy at `/warcraft-learner/data/specs/` instead of duplicating it into each `pr-N/` folder. For local dev, pull the data into your working tree with `npm run data:pull` (run from `frontend/`) - it fetches `origin/data` and restores the files (they stay ignored, so they never re-enter `main`).

## Commands (run from `frontend/`)

| Command | Description |
|---|---|
| `npm start` | Angular dev server on http://localhost:4200 |
| `npm run build` | Production build to `../static/angular/` |
| `npm test` | `ng test` (frontend Vitest) + scripts Vitest + scripts typecheck |
| `npm run lint` | `ng lint` over `src/**` then `eslint scripts` over `scripts/**` |
| `npm run ingest` | Run the ingestion orchestrator (needs `WCL_CLIENT_ID`/`WCL_CLIENT_SECRET`) |
| `npm run scrape` | Re-scrape all guides (or `--spec Name --url URL` to add one) |
| `npm run rulebook` | Manage rulebooks (build AI prompt, save AI JSON) |

## Development workflow router

Load the matching skill(s) **before** you start that step. The `warcraft-*` skills are this project's rules; `angular-developer` and `solid` are generic references (project rules win on conflict); `/code-review`, `/simplify`, `/verify`, `/run` are built-in skills.

| When you are... | Load before you start |
|---|---|
| Planning / scoping any change | the `Plan` agent + **warcraft-architecture** (+ the domain skill for the area) |
| Designing / building Angular UI (components, templates, styling, pipes, services) | **angular-developer** + **warcraft-frontend** |
| Writing user-facing copy, findings, microcopy, or anything branded (titles, nav, banners, READMEs, favicon) | **warcraft-copy** |
| Working on a vertical slice, a transform, analysis math, or layer boundaries | **warcraft-architecture** |
| Touching WCL queries, gear / spec / talent / enchant extraction, positions, or `wcl-auth` / the embedded secret | **warcraft-wcl-data** |
| Ingestion, rulebooks, scraping, `data/specs` file shapes, or `INGEST_VERSION` | **warcraft-ingestion** |
| Writing or changing tests | **warcraft-testing** |
| General refactor / code-quality cleanup | **solid** + `/simplify` (project rules win on conflict) |
| Reviewing code, a diff, or a PR | `/code-review` + **solid** + the domain skill(s) for the changed area |
| Verifying a change runs / manual end-to-end check | `/verify` or `/run` |

On any conflict between a skill and this file, or between a generic skill (`angular-developer`, `solid`) and a `warcraft-*` project skill, the **project skill / this file wins**.
