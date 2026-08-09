---
name: warcraft-writing
description: warcraft-learner user-facing writing and branding rules. Covers the terse-expert-analyst UI copy voice for all finding messages, remedies, card subtitles, empty states and microcopy, plus the product branding/naming rules (the warcraft-learner wordmark, never conflating it with Warcraft Logs/WCL) and the logo/favicon source of truth. Load this before writing or editing any string a user sees - findings, remedies, labels, empty states, page titles, nav wordmark, CLI banners, READMEs - or before touching the logo/favicon.
---

# warcraft-learner writing and branding

**Deliverable:** every string a user sees follows the voice rules below - fact then fix, no hedging, no statistics clutter, quiet success states - and the product name stays exactly `warcraft-learner`.

## Branding & naming

- **The product name is always `warcraft-learner`** - lowercase, hyphenated, exactly that casing. Never "Warcraft Learner", "WarcraftLearner", or any other variant. This applies to the page `<title>`, nav wordmark, CLI banners, READMEs, and any new user-facing copy.
- **Do not confuse it with "Warcraft Logs"** (a.k.a. WCL) - that is the external data provider, a separate product. Leave "Warcraft Logs" / "WCL" strings as-is; only our own app name is normalized to `warcraft-learner`.
- **Logo / favicon** - gold shield with an ascending bar chart. Single source of truth: `frontend/public/favicon.svg`, which drives the `.ico` (regenerated at 16/32/48px via `sharp` + `png-to-ico`, never hand-edited) and the nav-bar mark. `index.html` references the SVG first (`type="image/svg+xml"`) with the `.ico` as legacy fallback. The nav-bar logo (`shared/components/page-nav`) is the same artwork inlined as SVG so it themes with CSS vars - set its fills via Tailwind classes (`fill-[var(--gold)]` / `fill-[var(--surface)]`), **not** `fill="var(--…)"` attributes (browsers don't reliably honor them). Brand gold `--gold` (`#e5cc80`) is the WCL 100-parse "Astounding" gold; the favicon's literal hex must track the `styles.scss` tokens.

## UI copy voice (terse expert analyst)

All user-facing copy - finding messages, remedies, card subtitles, empty states, microcopy - is written for a logs-literate Mythic raider. It reads like a peer raid lead, not an encouraging coaching bot. This is enforced by convention (no linter), so apply it whenever you add or edit any string a user sees. The reference implementations are the finding messages in `rotation.service.ts` / `defensive.service.ts` and the gear notes in `shared/gear/gear-comparison.ts`.

- **State the fact, then the fix.** Findings are `message` (what happened) + `details.remedy` (one imperative action). Keep each to one short clause. `"Shadow Blades: 2 casts, expected 4. 2 lost."` then `"Press Shadow Blades 2x more - sooner off cooldown."`
- **No hedging or false optionality.** Never `Consider ...`, `you might want to`, `try to`, `~` before a benchmark, or `should`. Give the call: `"Hold Vanish to 3:20."`, not `"Consider holding Vanish until ~3:20."`
- **No statistics clutter in prose.** Never put `±stddev`, `avg`, or parenthetical variance into a sentence. Round the number and name the target plainly: `"... 4s late. Top: 0:08."` The exact thresholds still live in the bench math; the copy just reports the outcome.
- **Drop the repeated appeal-to-authority tail.** Do not end every line with `... than top parsers` / `... of top parsers use X`. Say it once, compactly: `"80% run this trinket"`, `"Top: 91%"`. Card subtitles follow the short `"<thing> vs top parses"` form (e.g. `"Offensive cooldowns vs top parses."`), never `"How your X compares to top parses."`
- **State facts, not praise.** A clean result is `"Standard build."` / `"On plan"`, never `"Matches top parsers"` / `"On a top-parse build"` / a celebratory tone. Empty states are neutral (`"Nothing flagged."`, `"No talent data."`) - never `"No issues detected!"` and never the optimistic `"... yet."` that implies the system is still filling in.
- **No decorative glyphs or emoji in copy.** No `✓`/`✗`/`⚠`/emoji as inline text; use words (`Kill` / `Wipe #3`) or a themed `mat-icon` where a glyph is genuinely needed.
- **Active voice, present tense, lower-case after the colon.** `"Cloak first used at 1:12"`, not `"Cloak of Shadows was first deployed at ..."`. Avoid filler verbs like `Deploy`, `leverage`, `utilize` - prefer `Use`, `Press`, `Hold`, `Open with`.
- **"On plan" success states are quiet.** Use the neutral `.chip-onplan` tag (defined in `styles.scss`), not a green pill with a `check_circle`. A correct result should read as calm, not celebrated.

> Note: the repo-wide ban on em-dashes/en-dashes/Unicode-minus (ASCII hyphen only) lives in the always-on `CLAUDE.md` because it governs every file and commit, not just user-facing copy. It applies here too.
