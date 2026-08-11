---
name: warcraft-rulebook
description: Generate or refresh warcraft-learner spec rulebooks on demand (no stored guide corpus, no CLI). The orchestrator preps stripped SimulationCraft APLs, rotation guide text, and a WCL-verified ability-id table per spec, then dispatches the `rulebook-author` subagent once per spec to turn those local files into that spec's rulebook.json. Load this whenever creating or refreshing rulebook.json for one, several, or all specs - at a new patch or tier, or when onboarding a new spec. The outcome contract lives here; the URL recipes, WCL queries, validation scripts, and the gh-pages publish recipe live in reference.md in this directory.
---

# warcraft-learner rulebook generation

**What good looks like:** one `frontend/public/data/specs/{spec}/rulebook.json` per selected spec, regenerated clean-slate from current sources, in which every spell id was observed in real top parses and every number in the coaching copy traces to an APL line or a guide sentence. Never read, copy, or patch the old `rulebook.json` - every run is a clean-slate regeneration.

**Division of labor:** the **orchestrator** (you) does everything mechanical - source fetching, stripping, spell-id grounding, schema validation, publishing. The **`rulebook-author` subagent** (`.claude/agents/rulebook-author.md`) does exactly one thing: transform a spec's prepped local files into its rulebook JSON. Its `tools` allowlist is `Read` + `Edit` only, so it has no network access and never sees credentials as a property of the agent definition; every byte it reads comes from the scratchpad files you prepared.

**The contract:** `.claude/skills/warcraft-rulebook/rulebook.schema.json` is the authoritative shape - ingestion consumes rulebooks directly with no code-side validation, so the schema plus the validation pass below is the only gate. Field meanings live in the schema's `description` strings (`usage_rule` is user-facing coaching copy and must never carry spell-id uncertainty - that goes in `id_note`). A rule's `action` says how to fix the mistake, never the target: the finding carries that from the bench.

## The five steps - outcome contract

1. **Pick the specs, get one WCL token.** Resolve the user's selection ("all", a class, a role, explicit names) to folder keys from the live spec universe and confirm the list before prepping. One OAuth handshake per session, reused for everything.
2. **Prep the sources (orchestrator, per spec).** Write three scratchpad files per spec - stripped SimC APL, stripped rotation guide with ids inlined, WCL-verified ability table - plus one session-wide spec-icon lookup. The file shapes and recipes are reference.md sections 2a-2d. **Never author spell ids from memory: the ability table is where every id comes from**, and an aura id only earns its row by appearing in sampled parses' `Buffs`/`Debuffs` tables.
3. **Dispatch `rulebook-author` once per spec - even for a single spec.** The orchestrator never authors a rulebook inline. Each dispatch gets only its folder key, `[className, specName]`, its spec icon stem, its three scratchpad paths, and the output path - nothing about any other spec or the existing rulebook, so rulebooks cannot mix. Dispatch as many at once as the environment allows. The agent's input contract, output shape, and quality bar live in `.claude/agents/rulebook-author.md`; reject and re-dispatch a run whose output misses the bar.
4. **Validate and write (orchestrator).** Each dispatch overwrites `frontend/public/data/specs/{spec}/rulebook.json` (pretty-printed, `spec` = folder key, required `spec_icon` set, no `guide_count`/`saved_at`). Then run the full validation pass from reference.md over **every file on disk for the selected specs** - a killed run leaves a plausible file behind whose failure notice says nothing about it. Send a single-rule defect back to the spec's live dispatch; reserve a fresh dispatch for broad misses.
5. **Publish, as two PRs.** `public/data/specs/**` is gitignored on code branches; rulebooks live on `gh-pages` at `data/specs/{spec}/rulebook.json`. Publish via a `gh-pages` worktree and a PR with base `gh-pages`, **plus** a PR against `main` bumping `INGEST_VERSION` - the skip signature never reads the rulebook, so without it a settled encounter keeps serving the old rules. Once both land, the hourly ingest rebuilds that spec's benches over its next passes (see CLAUDE.md).

## Reference

The recipes for each step - WCL token + spec-universe + rankable-encounter queries, the SimC/Wowhead/Icy Veins URL formats and discovery rules, the ability-table build procedure, the wago.tools icon lookup, the validation scripts, and the gh-pages worktree recipe - are in **`reference.md`** in this directory. Load the section for the step you are executing.
