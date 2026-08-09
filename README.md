# warcraft-learner

A web-based diagnostic tool for Mythic WoW raiders. It fetches your combat data from Warcraft Logs, evaluates it against spec-specific rulebooks, and delivers prescriptive, coaching-style feedback benchmarked against top-parse players.

**Live site: https://warcraft-learner.com/**

## What it does

- **Analyzes cooldown usage** - finds lost casts, poor Bloodlust alignment, slow openers, and held cooldowns.
- **Compares you to top parsers** - uses-per-minute and first-cast timing against the top 10 WCL parses for the boss.
- **Detects hold patterns** - flags when you fire a cooldown earlier than top parsers consistently delay it.
- **Maps burst windows** - surfaces recurring damage windows across top parses and the cooldowns active in them.
- **Evaluates rotation rules** - a rulebook-driven engine, not hardcoded spec logic.
- **Pre-fight gear check** - compares your trinkets, talents, and enchants against top parsers for each boss.
- **Replays your pull** - opt-in screen recording during a live raid, then a clip of each burst/defensive window cut to the WCL timeline. Everything stays in the browser; nothing is uploaded.

All thresholds are derived from real top-parse data for the same encounter and spec, not arbitrary constants.

## Run locally

```bash
cd frontend
npm install
npm run data:pull   # fetch the generated bench data from the `gh-pages` branch (see below)
npm start           # Angular dev server on http://localhost:4200
npm run start:empty # same, but with every encounter's bench emptied (fresh-tier empty states)
```

The ~100 MB of generated bench data (minified JSON) under `frontend/public/data/specs/**` is not tracked on `main`; it lives once on the `gh-pages` branch at the site root under `data/specs/`, the single shared copy the deployed site serves. `npm run data:pull` fetches `origin/gh-pages` and extracts those files into your working tree, where they remain gitignored. Re-run it whenever you want the latest parse data.

The app is a fully static Angular SPA. It talks directly to the Warcraft Logs API from the browser using an OAuth2 client-credentials token (no user login); there is no backend.

## Documentation

See [`CLAUDE.md`](./CLAUDE.md) for the development entry point: architecture at a glance, commands, and the router into the on-demand skills under [`.claude/skills/`](./.claude/skills/) that hold the detailed conventions (change contract, writing, WCL/data, rulebook generation).

## License

AGPLv3, see [`LICENSE`](./LICENSE).
