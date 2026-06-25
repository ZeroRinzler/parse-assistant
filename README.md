# warcraft-learner

A web-based diagnostic tool for Mythic WoW raiders. It fetches your combat data from Warcraft Logs, evaluates it against spec-specific rulebooks (AI-generated from guides), and delivers prescriptive, coaching-style feedback benchmarked against top-parse players.

**Live site: https://gpolcode.github.io/warcraft-learner/**

## What it does

- **Analyzes cooldown usage** - finds lost casts, poor Bloodlust alignment, slow openers, and held cooldowns.
- **Compares you to top parsers** - uses-per-minute and first-cast timing against the top 10 WCL parses for the boss.
- **Detects hold patterns** - flags when you fire a cooldown earlier than top parsers consistently delay it.
- **Maps burst windows** - surfaces recurring damage windows across top parses and the cooldowns active in them.
- **Evaluates rotation rules** - a rulebook-driven engine, not hardcoded spec logic.
- **Pre-fight gear check** - compares your trinkets, talents, and enchants against top parsers for each boss.

All thresholds are derived from real top-parse data for the same encounter and spec, not arbitrary constants.

## Run locally

```bash
cd frontend
npm install
npm start   # Angular dev server on http://localhost:4200
```

The app is a fully static Angular SPA. It talks directly to the Warcraft Logs API from the browser via OAuth2 PKCE; there is no backend.

## Documentation

See [`CLAUDE.md`](./CLAUDE.md) for the full technical reference: architecture, data models, the ingestion and rulebook workflow, GitHub Actions automation, and how the analysis thresholds work.
