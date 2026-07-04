---
name: warcraft-rulebook
description: Generate or refresh warcraft-learner spec rulebooks on demand (no stored guide corpus, no CLI). Fetches SimulationCraft action-priority lists and Wowhead guides and grounds spell ids against live Warcraft Logs, fanning out one isolated subagent per spec. Load this whenever creating or refreshing rulebook.json for one, several, or all specs - at a new patch or tier, or when onboarding a new spec. Knows the SimC + Wowhead source URLs and their per-tier discovery, the WCL grounding query, the schema contract, the output path, and how rulebooks are published.
---

# warcraft-learner rulebook generation

A rulebook (`rulebook.json`) is the per-spec contract the ingestion transforms consume: the spec's
major offensive cooldowns, personal defensives, a handful of machine-checkable usage rules - each with a
**real WoW spell id** - and the spec's icon stem. One file per spec under
`frontend/public/data/specs/{spec}/rulebook.json`. The agent reads the sources and writes the JSON
directly - no copy-paste, no `guides.json`, no CLI. Every run is a **clean-slate regeneration**: build each
rulebook fresh from the sources below and overwrite the existing file - never read, copy, or patch the old
`rulebook.json`.

The schema is the authoritative shape: **`.claude/skills/warcraft-ingestion/rulebook.schema.json`**. Read
it first and make the output conform to it - the schema is the only contract, since ingestion consumes
rulebooks directly (no code-side validation). The field meanings live in the schema's own `description`
strings; follow them exactly (especially: `usage_rule` is user-facing coaching copy and must never carry
spell-id uncertainty; put that in `id_note`).

## When to use

- A new patch/tier reshapes cooldowns, adds tier-set-driven timing, or churns spell ids -> refresh the affected specs.
- Onboarding a new spec (a new class or a new spec) -> generate its first rulebook.
- A spec's analysis looks wrong (a missing cooldown, an ability with no art) -> regenerate that spec.

## Step 1 - pick the specs

Enumerate the spec universe live from WCL:

```
query { gameData { classes { name slug specs { name slug } } } }
```

Each `spec.slug + class.slug` is the folder key (e.g. `Subtlety` + `Rogue` -> `SubtletyRogue`;
`Devourer` + `DemonHunter` -> `DevourerDemonHunter`). Ask the user which specs to do - accept "all", a
class, a role ("healers"), or explicit names - resolve to folder keys, and confirm the list before
fanning out. (Auth for the query: client-credentials in `frontend/src/app/core/services/wcl-auth.ts`, or
`WCL_CLIENT_ID`/`WCL_CLIENT_SECRET`. POST `grant_type=client_credentials` to
`https://www.warcraftlogs.com/oauth/token`, then POST GraphQL to
`https://www.warcraftlogs.com/api/v2/client` with `Authorization: Bearer <token>`.)

## Step 2 - the sources (per spec)

Ground every rulebook in real data; never author spell ids from memory alone. Three sources, combined
with WoW domain knowledge:

### A. SimulationCraft APL - primary for DPS and tanks

SimC ships an action-priority list per DPS/tank spec: the exact cast priority, cooldown pairings, BL
syncs, and the opener, plus a `talents=` string. Fetch the raw profile:

```
https://raw.githubusercontent.com/simulationcraft/simc/<branch>/profiles/<TIER>/<TIER>_<ClassName>_<SpecName>.simc
```

- `<branch>` is SimC's **current-expansion branch** - `midnight` now (`thewarwithin` was the prior one).
  **Never use `main` or the repo default: they carry no current profiles (`.../simc/main/profiles/...` 404s).**
  If unsure of the name, it is the current WoW expansion lowercased with no spaces; confirm it resolves by
  checking `https://raw.githubusercontent.com/simulationcraft/simc/<branch>/profiles/` before fetching.
- `<TIER>` is the latest tier profile dir on that branch, e.g. **`MID1`**. Do not hard-trust it across tiers -
  list `https://api.github.com/repos/simulationcraft/simc/contents/profiles?ref=<branch>` and pick the highest
  `MID<n>`. The path moves every tier; discover it.
- `<ClassName>_<SpecName>` are the no-space forms (e.g. `Rogue_Subtlety`, `Hunter_BeastMastery`,
  `DeathKnight_Frost`). If a fetch 404s, list the tier dir to confirm the exact filename (SimC sometimes
  suffixes hero-talent variants; take the base spec file).

APL conditions like `racial_sync,value=buff.shadow_blades.up&buff.shadow_dance.up` or `if=cooldown.X.remains`
translate directly into `major_cooldowns`, `align_with_bloodlust`, `opener_priority`, and the two rule conditions.

### B. Wowhead guide - the source for every spec (incl. the healers SimC omits)

SimC has no healer profiles; Wowhead covers every spec. Its guide pages are server-rendered, so a plain
fetch returns the full body (no browser needed):

```
https://www.wowhead.com/guide/classes/<class-kebab>/<spec-kebab>/<subpage>-pve-<role>
```

- `<class-kebab>`: `rogue`, `paladin`, `demon-hunter`, `death-knight` (hyphenated for two-word classes).
- `<spec-kebab>`: `subtlety`, `holy`, `devourer`, `beast-mastery`.
- `<subpage>`: `rotation-cooldowns` (the key page), `overview`, `talent-builds`.
- `<role>`: `dps` / `healer` / `tank`. If a role suffix 404s, try the others.

Fetch the raw HTML and strip tags to text (the guide body lives in a `guide-body` block). It is the source
for the healer specs SimC omits and a useful cross-check for everyone. The page also carries the spec's
**icon stem** (e.g. `ability_stealth`) - capture it for the rulebook's `spec_icon`, which is **required**.

### C. Warcraft Logs - spell-id grounding

Resolve/verify every id you plan to write with a batched `gameData` query
(`query{ a<ID>: ability(id:<ID>){id name icon} ... }`); a `null` means the id does not exist - use a real
one instead. For the healer specs especially, enumerate the spec's actual kit from a top parse's
`masterData{abilities{gameID name icon}}` (get a top `report.code` from
`worldData{encounter(id:E){characterRankings(className:C specName:S metric:hps)}}`), so ids come from real
logs rather than memory. Ground the ids here, at authoring time - ingestion does not re-check them.

## Step 3 - fan out one isolated subagent per spec

**Always spawn one subagent per selected spec - even when only a single spec is chosen.** The main agent
never generates a rulebook inline; its whole job is to pick the specs (Step 1), spawn the subagents, and
collect their reports. **Each subagent runs in a clean, empty context with exactly one job: produce that
single spec's rulebook from scratch.** Give it only its own folder key + `[className, specName]` + the
schema + the source recipe + the output path - nothing about any other spec, and nothing about the existing
rulebook. Subagents share no context and must never see or reference another spec, so rulebooks cannot mix
(a Fury Warrior rulebook contains only Fury Warrior abilities, never Arms). Batch the subagents for concurrency.

Each subagent (starting from a clean slate - it does not read or reuse the existing `rulebook.json`):
1. Fetches its SimC profile (skip for the healer specs SimC omits - go straight to Wowhead + WCL kit enumeration).
2. Fetches its Wowhead guide, captures the spec icon stem, and grounds ids against WCL.
3. Extracts the rulebook JSON to the schema (all `major_cooldowns`, all `defensives` with cooldown >= 15s,
   5-10 high-signal `rules`, `source_summary`, `spec_icon`). Spec-only abilities - never another spec of the same class.
4. Writes the file (Step 4).
5. Returns a one-line report: spec, cooldown/defensive/rule counts, and any id it could not ground from logs.

The two supported rule `condition` kinds (`cast_without_prior`, `hold_cooldown_for_anchor`) have worked
examples in the schema's `$defs`.

## Step 4 - write

Write (overwriting any existing file) to `frontend/public/data/specs/{spec}/rulebook.json` (pretty-printed; set `spec` to the folder key
and the **required** `spec_icon` to the captured stem - never leave it empty; leave `guide_count`/`saved_at` out). Conform to the schema - it is
the only contract. Ingestion consumes the rulebook directly with no code-side check, so every id must be
real; that is what the WCL grounding in Step 2 is for.

## Step 5 - publish

The generated `rulebook.json` files live under the (gitignored) data tree. Publish them into the gh-pages
`data/specs/` tree - the shared dataset the site serves. The scheduled ingest runs then read them and
rebuild that spec's benches over their next passes.
