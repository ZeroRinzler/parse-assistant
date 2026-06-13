# warcraft-learner

**[Live site → gpolcode.github.io/warcraft-learner](https://gpolcode.github.io/warcraft-learner/)**

A web-based diagnostic tool for Mythic WoW raiders. It fetches combat data from Warcraft Logs, evaluates it against spec-specific rulebooks (AI-generated from guides), and delivers prescriptive, coaching-style feedback with comparison against top-parse players.

## What it does

- **Analyzes your cooldown usage** - finds lost casts, poor BL alignment, slow openers, and held cooldowns. All thresholds are derived from real top-parse data for the same encounter, not arbitrary constants.
- **Compares you to top parsers** - uses-per-minute and first-cast timing benchmarked against the top 10 WCL parses for that boss.
- **Detects hold patterns** - identifies when top parsers consistently delay a cooldown past its reset time, and flags when you're using it earlier than they do.
- **Maps burst windows** - finds recurring damage windows across top parses (anchored to CD casts, variable length) and shows which cooldowns are active in them.
- **Evaluates rotation rules** - the rule engine checks things like "Shadow Dance should always follow Secret Technique" or "don't use Dance within 15s of an incoming Shadow Blades" - driven by a rulebook, not hardcoded spec logic.
- **Pre-fight gear check** - compare your current trinkets, talents, and enchants against what top parsers are running on each boss.

## Quick start

```bash
cd frontend
cp ../.env.example ../.env   # fill in WCL OAuth credentials
npm install
npm start                    # Angular dev server on http://localhost:4200
```

The Angular app is fully static and communicates directly with the WCL API via OAuth2 PKCE.

## Setup flow

1. **Admin CLI**: `npm run admin` - interactive CLI for guide management and rulebook generation.
2. **Ingest parses**: `npm run ingest` - fetches and analyzes the top 10 WCL parses for every current-expansion boss. Powers data-derived thresholds, hold pattern detection, and burst window analysis.
3. **Add guides**: `npm run scrape` - add guide URLs (web, YouTube, SimC APL), scrape their content.
4. **Generate rulebook**: in `npm run admin`, select a spec → "Print AI prompt" → paste into any LLM (Claude, ChatGPT, etc.) → paste the JSON output back to save the rulebook.
5. **Player page**: sign in with WCL, paste a report URL - fight and player selectors appear automatically.

Steps 1-4 are per-spec and only need to be done once (or to refresh data).

## Scripts

All scripts run from `frontend/`:

| Command | Description |
|---|---|
| `npm start` | Angular dev server (port 4200) |
| `npm run build` | Production build to `../static/angular/` |
| `npm run ingest` | Ingest top WCL parses for a spec (interactive or `--spec Name --all`) |
| `npm run scrape` | Add and scrape guide URLs (interactive or `--spec --url --type`) |
| `npm run admin` | Manage rulebooks (generate prompt, save AI JSON output) |

## GitHub Actions automation

Two workflows keep spec data up to date automatically:

| Workflow | Trigger | Script |
|---|---|---|
| `ingest-parses.yml` | Daily at 06:00 UTC (or manual) | `node frontend/scripts/ingest.mjs` |
| `scrape-guides.yml` | Manual (`workflow_dispatch`) | `node frontend/scripts/scrape.mjs` |

Set `WCL_CLIENT_ID` and `WCL_CLIENT_SECRET` as repository secrets. The workflows commit updated `frontend/public/data/specs/**` files back to the repo after each run.

## Credentials needed

| Secret | Where to get it |
|---|---|
| `WCL_CLIENT_ID` | [Warcraft Logs API clients](https://www.warcraftlogs.com/api/clients/) |
| `WCL_CLIENT_SECRET` | Same page - required for server-side ingestion scripts |

No Anthropic API key is required. The rulebook generation workflow uses a copy-prompt → paste-back flow that works with any LLM.

## How thresholds work

All analysis thresholds adapt to the encounter and spec via top-parse data:

| Check | Benchmark |
|---|---|
| First-cast delay | avg first-cast time across top parses ± 2σ |
| Gap between uses | avg inter-cast gap across top parses ± 2σ |
| Hold suggestion | cast index where ≥40% of top parsers delay past on-cooldown time |
| Downtime floor | p90 of pooled inter-cast gaps from top parses |
| Efficiency warning | 1σ below top-parse avg triggers warning; 2σ triggers critical |
| BL timing | avg BL-offset across top parses ± 2σ |
| Burst windows | CD-cast-centric windows (variable length), clustered across top parses |

If no parse samples exist for the encounter, all checks fall back to conservative static values.

## Architecture overview

```
frontend/
├── src/app/
│   ├── pages/
│   │   ├── post-raid/     - post-raid analysis UI
│   │   ├── pre-fight/     - pre-fight gear/talent check
│   │   └── live/          - live raid mode (auto-polls)
│   └── core/services/
│       ├── wcl-auth.ts    - WCL OAuth2 PKCE login
│       ├── wcl-api.ts     - WCL GraphQL client
│       ├── analysis.ts    - delegates to AnalysisEngineService
│       └── analysis-engine.ts - TypeScript port of the full analyzer
├── scripts/
│   ├── ingest.mjs         - parse ingestion CLI (no server needed)
│   ├── scrape.mjs         - guide scraper CLI
│   └── admin.mjs          - rulebook management CLI
└── public/data/specs/     - static data files (served by Angular dev server)
    └── {Spec}/
        ├── rulebook.json
        ├── guides.json
        ├── encounters.json
        └── encounters/{id}.json
```

See `CLAUDE.md` for the full technical reference including data models, rulebook JSON schema, and the rule condition engine.
