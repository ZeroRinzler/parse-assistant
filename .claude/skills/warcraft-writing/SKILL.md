---
name: warcraft-writing
description: warcraft-learner user-facing writing and branding rules. Covers the plain-spoken coaching UI copy voice for all finding messages, remedies, card subtitles, empty states and microcopy, plus the product branding/naming rules (the warcraft-learner wordmark, never conflating it with Warcraft Logs/WCL) and the logo/favicon source of truth. Load this before writing or editing any string a user sees - findings, remedies, labels, empty states, page titles, nav wordmark, CLI banners, READMEs - or before touching the logo/favicon.
---

# warcraft-learner writing and branding

**Deliverable:** every string a user sees follows the voice rules below - count then target, plain words, one actionable number, quiet success states - and the product name stays exactly `warcraft-learner`.

## Branding & naming

- **The product name is always `warcraft-learner`** - lowercase, hyphenated, exactly that casing. Never "Warcraft Learner", "WarcraftLearner", or any other variant. This applies to the page `<title>`, nav wordmark, CLI banners, READMEs, and any new user-facing copy.
- **Do not confuse it with "Warcraft Logs"** (a.k.a. WCL) - that is the external data provider, a separate product. Leave "Warcraft Logs" / "WCL" strings as-is; only our own app name is normalized to `warcraft-learner`.
- **Logo / favicon** - gold shield with an ascending bar chart. Single source of truth: `frontend/public/favicon.svg`, which drives the `.ico` (regenerated at 16/32/48px via `sharp` + `png-to-ico`, never hand-edited) and the nav-bar mark. `index.html` references the SVG first (`type="image/svg+xml"`) with the `.ico` as legacy fallback. The nav-bar logo (`shared/components/page-nav`) is the same artwork inlined as SVG so it themes with CSS vars - set its fills via Tailwind classes (`fill-[var(--gold)]` / `fill-[var(--surface)]`), **not** `fill="var(--…)"` attributes (browsers don't reliably honor them). Brand gold `--gold` (`#e5cc80`) is the WCL 100-parse "Astounding" gold; the favicon's literal hex must track the `styles.scss` tokens.
- **Share card** - `frontend/public/og-image.png` (1200x630): the shield over the wordmark, a tagline, and one gold call to action, a favicon derivative to regenerate with the logo. Backs `og:image` in `frontend/src/index.html` and `.github/pages-root/index.html`, which carry identical tags. The GitHub repo card is the same artwork at 1280x640, uploaded in repo settings rather than tracked here.

## UI copy voice (plain-spoken coach)

All user-facing copy - finding messages, remedies, card subtitles, empty states, microcopy - is written so a raider reads it once and knows what to change. Plain words over jargon, and never a number whose meaning the reader has to infer. This is enforced by convention (no linter), so apply it whenever you add or edit any string a user sees. The reference implementations are the finding messages in the rotation rule kinds and `rotation-feature-service.ts` / `defensive-feature-service.ts`, and the gear notes in `domain/gear/gear-comparison-service.ts`.

- **Count first, target second, in one sentence each.** A finding reads `<what happened>. <what to hit>.` `"4 of 12 Black Powders hit fewer than 3 targets. Wait for 3 or more."` Never staple two fragments together with a colon or a trailing label.
- **Name the comparison group in words: `top raiders`.** Never a bare `"Top:"` prefix, never `"the field"` - both are internal shorthand that means nothing to a new user. `"Top raiders average 12s."`, not `"top 12s."`
- **Show the one number the player should hit, never the internal range.** A band has two edges but only the judged one is actionable, so print that edge as a target: `"Aim for 90% or more."`, `"Wait for 3 or more."`, `"Cast it within 1.2s."` Never `"90-97%"` - a range makes the reader guess which end matters.
- **A rate reads better as odds than as a percent.** `"Top raiders waste at most 1 in 10."`, not `"Top: 0-10%."`
- **No hedging or false optionality.** Never `Consider ...`, `you might want to`, `try to`, `~` before a benchmark, or `should`. Give the call: `"Hold Vanish to 3:20."`, not `"Consider holding Vanish until ~3:20."`
- **No statistics clutter in prose.** Never put `±stddev`, `avg`, or parenthetical variance into a sentence. Round the number and name the target plainly. The exact thresholds still live in the bench math; the copy just reports the outcome.
- **The compact `measured` cell is exempt.** `{ value, unit }` renders in a narrow table column, so it keeps the short form (`+4s` / `top 0:08`). The prose rules above govern `message`, `remedy` and `occurrenceTarget`.
- **`message` states the target, `remedy` says how to get it.** The two must not repeat each other: `"Rupture was up 78% of the fight. Aim for 90% or more."` pairs with `"Refresh Rupture inside its last 30%."`, never with `"Get Rupture to 90%."`
- **State facts, not praise.** A clean result is `"Standard build."` / `"On plan"`, never `"Matches top parsers"` / `"On a top-parse build"` / a celebratory tone. Empty states are neutral (`"Nothing flagged."`, `"No talent data."`) - never `"No issues detected!"` and never the optimistic `"... yet."` that implies the system is still filling in.
- **No decorative glyphs or emoji in copy.** No `✓`/`✗`/`⚠`/emoji as inline text; use words (`Kill` / `Wipe #3`) or a themed `mat-icon` where a glyph is genuinely needed.
- **Plain verbs, and address the player as `you` where it reads naturally.** `"You refreshed Rupture early 4 of 9 times."` Avoid filler verbs like `Deploy`, `leverage`, `utilize` - prefer `Use`, `Press`, `Hold`, `Spend`, `Wait for`, `Aim for`.
- **"On plan" success states are quiet.** Use the neutral `.chip-onplan` tag (defined in `styles.scss`), not a green pill with a `check_circle`. A correct result should read as calm, not celebrated.

> Note: the repo-wide ban on em-dashes/en-dashes/Unicode-minus (ASCII hyphen only) lives in the always-on `CLAUDE.md` because it governs every file and commit, not just user-facing copy. It applies here too.
